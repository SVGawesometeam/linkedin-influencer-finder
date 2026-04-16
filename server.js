const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '200kb' }));

// Prevent browser caching of HTML so deploys take effect immediately
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// =============================================
// Helper: call Anthropic API
// =============================================
async function callAnthropic(systemPrompt, userMessage, maxTokens = 4000) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errText}`);
  }

  return response.json();
}

// =============================================
// Helper: Apify actor runner
// =============================================
async function runApifyActor(actorId, input, maxChargeUsd = 1.0) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error('APIFY_API_TOKEN not configured');

  // Pay-per-event actors REQUIRE maxTotalChargeUsd to be set, otherwise
  // the actor has no spending authority and silently returns 0 results
  const url = `https://api.apify.com/v2/acts/${actorId}/runs?token=${token}&maxTotalChargeUsd=${maxChargeUsd}`;
  console.log(`Starting Apify actor: ${actorId} (budget: $${maxChargeUsd})`);

  const startRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }
  );

  if (!startRes.ok) {
    const err = await startRes.text();
    throw new Error(`Apify start failed: ${err}`);
  }

  const run = await startRes.json();
  const runId = run.data.id;

  // Poll until finished (max 3 minutes)
  const maxWait = 180000;
  const pollInterval = 3000;
  let elapsed = 0;

  while (elapsed < maxWait) {
    await new Promise(r => setTimeout(r, pollInterval));
    elapsed += pollInterval;

    const statusRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${token}`
    );
    const statusData = await statusRes.json();
    const status = statusData.data.status;

    if (status === 'SUCCEEDED') {
      const datasetId = statusData.data.defaultDatasetId;
      const itemsRes = await fetch(
        `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}`
      );
      return itemsRes.json();
    }

    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      const errorInfo = statusData.data.statusMessage || status;
      console.error('Apify run failed:', errorInfo);
      throw new Error(`Apify run ${status}: ${errorInfo}`);
    }
  }

  throw new Error('Apify run timed out after 3 minutes');
}

// =============================================
// Helper: Supabase
// =============================================
async function supabaseQuery(method, table, params = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  const headers = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  if (method === 'POST') headers['Prefer'] = 'return=representation';

  let endpoint = `${url}/rest/v1/${table}`;

  if (method === 'GET') {
    const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    if (query) endpoint += `?${query}`;
  }

  const res = await fetch(endpoint, {
    method,
    headers,
    body: method !== 'GET' ? JSON.stringify(params.body) : undefined,
  });

  if (!res.ok) return null;
  return res.json();
}

async function getCachedNiche(niche) {
  const normalized = niche.toLowerCase().trim();
  const results = await supabaseQuery('GET', 'niche_cache', {
    'niche': `eq.${normalized}`,
    'select': '*',
    'order': 'created_at.desc',
    'limit': '1',
  });
  if (!results || results.length === 0) return null;

  const cached = results[0];
  const ageMs = Date.now() - new Date(cached.created_at).getTime();
  const fifteenDays = 15 * 24 * 60 * 60 * 1000;
  if (ageMs > fifteenDays) return null;

  return cached;
}

// Fuzzy cache: find semantically similar cached search using Claude
async function getFuzzyCachedNiche(cacheKey) {
  const fifteenDays = 15 * 24 * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - fifteenDays).toISOString();

  // Fetch all recent cache keys from Supabase
  const results = await supabaseQuery('GET', 'niche_cache', {
    'select': 'niche',
    'created_at': `gte.${cutoff}`,
    'order': 'created_at.desc',
    'limit': '100',
  });

  if (!results || results.length === 0) return null;

  // Get unique cache keys
  const cacheKeys = [...new Set(results.map(r => r.niche))];
  if (cacheKeys.length === 0) return null;

  console.log(`Fuzzy cache: comparing against ${cacheKeys.length} cached searches`);

  // Ask Claude to find the closest semantic match
  try {
    const data = await callAnthropic(
      `You match search queries. Given a NEW search and a list of CACHED searches, determine if any cached search is semantically close enough to reuse results. "Close enough" means the user is looking for the same type of people/content — minor wording differences are OK, but different topics are NOT.

Return ONLY one of:
- The exact cached key string if there's a good match
- "NONE" if nothing is close enough

No explanations, just the answer.`,
      `NEW SEARCH: "${cacheKey}"

CACHED SEARCHES:
${cacheKeys.map((k, i) => `${i + 1}. "${k}"`).join('\n')}`,
      100
    );

    const match = data.content[0].text.trim();
    if (match === 'NONE' || !match) return null;

    // Clean up — Claude might return with quotes
    const cleanMatch = match.replace(/^["']|["']$/g, '');

    // Verify it's actually one of our cache keys
    const found = cacheKeys.find(k => k === cleanMatch);
    if (!found) return null;

    console.log(`Fuzzy cache HIT: "${cacheKey}" matched "${found}"`);

    // Now fetch the full cached data for this key
    return getCachedNiche(found);
  } catch (e) {
    console.log('Fuzzy cache matching failed:', e.message);
    return null;
  }
}

async function saveNicheCache(niche, profiles, posts) {
  const normalized = niche.toLowerCase().trim();
  await supabaseQuery('POST', 'niche_cache', {
    body: {
      niche: normalized,
      profiles: JSON.stringify(profiles),
      posts: JSON.stringify(posts),
      created_at: new Date().toISOString(),
    },
  });
}

// =============================================
// Rate limiting: 5 searches per day per IP
// =============================================
const searchCounts = new Map(); // ip -> { count, resetAt }

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = searchCounts.get(ip);

  if (!entry || now > entry.resetAt) {
    searchCounts.set(ip, { count: 1, resetAt: now + 24 * 60 * 60 * 1000 });
    return { allowed: true, remaining: 4 };
  }

  if (entry.count >= 5) {
    const hoursLeft = Math.ceil((entry.resetAt - now) / (60 * 60 * 1000));
    return { allowed: false, remaining: 0, hoursLeft };
  }

  entry.count += 1;
  return { allowed: true, remaining: 5 - entry.count };
}

// Clean up expired entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of searchCounts) {
    if (now > entry.resetAt) searchCounts.delete(ip);
  }
}, 60 * 60 * 1000);

// =============================================
// API: Find influencers
// =============================================
app.post('/api/influencers', async (req, res) => {
  const { niche, role, goal } = req.body;
  if (!niche) return res.status(400).json({ error: 'Niche is required' });

  try {
    // Check cache first (doesn't count against rate limit)
    // Cache key includes role+goal + version so algorithm changes invalidate old results
    const CACHE_VERSION = 'v8';
    const cacheKey = [CACHE_VERSION, niche, role, goal].filter(Boolean).join('|');

    // 1. Try exact cache match (free, instant)
    const cached = await getCachedNiche(cacheKey);
    if (cached) {
      console.log(`Exact cache hit: ${cacheKey}`);
      return res.json({
        profiles: JSON.parse(cached.profiles),
        posts: JSON.parse(cached.posts),
        fromCache: true,
      });
    }

    // 2. Try fuzzy cache match via Claude (cheap — avoids expensive Apify calls)
    const fuzzyCached = await getFuzzyCachedNiche(cacheKey);
    if (fuzzyCached) {
      console.log(`Fuzzy cache hit for: ${cacheKey}`);
      return res.json({
        profiles: JSON.parse(fuzzyCached.profiles),
        posts: JSON.parse(fuzzyCached.posts),
        fromCache: true,
      });
    }

    // Rate limit: 5 new searches per day per IP (cached results are free)
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const rateCheck = checkRateLimit(clientIp);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        error: `Daily search limit reached (5 per day). Try again in ~${rateCheck.hoursLeft} hours. Tip: previously searched niches load instantly from cache.`,
      });
    }
    console.log(`Rate limit: ${rateCheck.remaining} searches remaining for ${clientIp}`);

    console.log(`Cache miss: ${niche}. Expanding keywords...`);

    // Step 0: Build search keywords
    // Use the goal directly PLUS a few synonyms so we don't miss relevant posts
    // that use different wording for the same topic.
    let allKeywords = [];
    const primaryTerm = goal || role || niche;

    if (goal) {
      allKeywords.push(goal);
      if (niche.toLowerCase() !== goal.toLowerCase()) {
        allKeywords.push(`${goal} ${niche}`);
      }
    } else if (role) {
      allKeywords.push(role);
      if (niche.toLowerCase() !== role.toLowerCase()) {
        allKeywords.push(`${role} ${niche}`);
      }
    } else {
      allKeywords.push(niche);
    }

    // Generate synonym keywords via Claude (tightly scoped to the goal meaning)
    try {
      const synonymData = await callAnthropic(
        `You generate LinkedIn search keywords. Return ONLY a JSON array of 3-4 short synonym phrases (2-4 words each) that mean the same thing as the user's topic. Stay VERY close to the original meaning — just rephrase it, don't broaden it. No explanations, just the JSON array.`,
        `Topic: "${primaryTerm}"${niche !== primaryTerm ? `\nField: ${niche}` : ''}`,
        200
      );
      const synonymText = synonymData.content[0].text.trim();
      const cleaned = synonymText.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
      const synonyms = JSON.parse(cleaned);
      if (Array.isArray(synonyms)) {
        // Add synonyms that aren't duplicates
        for (const s of synonyms) {
          const phrase = String(s).trim();
          if (phrase && !allKeywords.some(k => k.toLowerCase() === phrase.toLowerCase())) {
            allKeywords.push(phrase);
          }
        }
      }
      console.log(`Synonym expansion: ${JSON.stringify(synonyms)}`);
    } catch (e) {
      console.log('Synonym expansion failed, continuing with original keywords:', e.message);
    }

    // Also add the niche itself if not already included
    if (!allKeywords.some(k => k.toLowerCase() === niche.toLowerCase())) {
      allKeywords.push(niche);
    }

    // Build profile search query — search for people with this title/role
    const profileQuery = goal || role || niche;
    console.log(`Search keywords: posts=${JSON.stringify(allKeywords)}, profiles="${profileQuery}"`);

    // =============================================================
    // STRATEGY: Run BOTH searches in parallel
    // 1. Profile search → finds people who ARE video editors (relevant)
    // 2. Post search → finds posts about video editing (engagement data)
    // Then merge: profiles give relevance, posts give engagement
    // =============================================================

    const [postResults, profileResults] = await Promise.all([
      // Post search — for engagement data and content
      runApifyActor('harvestapi~linkedin-post-search', {
        searchQueries: allKeywords,
        maxPosts: 100,
      }, 0.25).catch(e => { console.log('Post search failed:', e.message); return []; }),

      // Profile search — for finding actual relevant people
      runApifyActor('harvestapi~linkedin-profile-search', {
        searchQuery: profileQuery,
        maxItems: 30,
        profileScraperMode: 'short',
      }, 0.10).catch(e => { console.log('Profile search failed:', e.message); return []; }),
    ]);

    let postSearchResults = Array.isArray(postResults) ? postResults : [];
    const profileSearchResults = Array.isArray(profileResults) ? profileResults : [];

    console.log(`Post search: ${postSearchResults.length} posts, Profile search: ${profileSearchResults.length} profiles`);

    if (profileSearchResults.length > 0) {
      console.log('Profile result keys:', Object.keys(profileSearchResults[0]).join(', '));
      console.log('Profile sample:', JSON.stringify(profileSearchResults[0]).slice(0, 500));
    }

    if (postSearchResults.length === 0 && profileSearchResults.length === 0) {
      throw new Error('We couldn\'t find influencers for this niche yet. Try broader terms like "marketing", "sales", or "leadership" — or describe your topic differently.');
    }

    // Filter out hiring/job posts
    const hiringWords = /\b(hiring|we're looking for|job opening|job opportunity|work from home job|urgent\s*hiring|apply now|join our team|remote job|we are hiring)\b/i;
    postSearchResults = postSearchResults.filter(p => {
      if (!p || typeof p !== 'object') return false;
      const text = String(p.text || p.postText || p.content || '');
      return !hiringWords.test(text);
    });
    console.log(`After filtering hiring posts: ${postSearchResults.length} posts remain`);

    // Build engagement map from posts
    const engagementMap = new Map(); // key → { totalEngagement, postCount }
    for (const post of postSearchResults) {
      const author = post.author || {};
      const authorKey = author.publicIdentifier || author.universalName || author.name;
      if (!authorKey) continue;

      if (!engagementMap.has(authorKey)) {
        // Extract profile picture from author.avatar.url
        const avatarObj = (author.avatar && typeof author.avatar === 'object') ? author.avatar : {};
        engagementMap.set(authorKey, {
          name: author.name || '',
          title: author.info || author.position || author.headline || author.description || '',
          profileUrl: author.linkedinUrl || author.url || (author.publicIdentifier ? `https://www.linkedin.com/in/${author.publicIdentifier}` : ''),
          profileImage: avatarObj.url || '',
          totalEngagement: 0,
          postCount: 0,
        });
      }

      const a = engagementMap.get(authorKey);
      const eng = (post.engagement && typeof post.engagement === 'object') ? post.engagement : {};
      const postEng = (Number(eng.likes) || 0) + (Number(eng.comments) || 0) * 3 + (Number(eng.shares) || 0) * 2;
      a.totalEngagement += postEng;
      a.postCount += 1;
    }

    // Build profile map from profile search (these are guaranteed relevant people)
    const profileMap = new Map();
    for (const p of profileSearchResults) {
      if (!p || typeof p !== 'object') continue;
      const key = p.publicIdentifier || p.universalName || p.name || '';
      if (!key) continue;
      profileMap.set(key, {
        name: p.name || p.fullName || '',
        title: p.title || p.headline || p.position || p.description || '',
        profileUrl: p.linkedinUrl || p.url || p.profileUrl || (p.publicIdentifier ? `https://www.linkedin.com/in/${p.publicIdentifier}` : ''),
      });
    }
    console.log(`Engagement map: ${engagementMap.size} authors, Profile map: ${profileMap.size} profiles`);

    // Merge: combine profile-searched people with engagement data
    const mergedMap = new Map();

    // First: add all profile-searched people (guaranteed relevant)
    for (const [key, profile] of profileMap) {
      const engagement = engagementMap.get(key);
      mergedMap.set(key, {
        name: profile.name,
        title: profile.title,
        profileUrl: profile.profileUrl,
        profileImage: engagement ? engagement.profileImage || '' : '',
        totalEngagement: engagement ? engagement.totalEngagement : 0,
        postCount: engagement ? engagement.postCount : 0,
        source: engagement ? 'both' : 'profile',
      });
    }

    // Second: add post authors whose title matches the goal (if not already added)
    const filterSource = goal || role || '';
    const words = filterSource.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const stems = words.map(w => w.replace(/(ing|er|or|ion|tion|ment|ness|ist|ity)$/, ''));
    const terms = [...new Set([...words, ...stems])].filter(t => t.length > 2);

    for (const [key, author] of engagementMap) {
      if (mergedMap.has(key)) continue; // already added from profile search
      // Only add if their title matches the goal
      const title = (author.title || '').toLowerCase();
      const titleMatches = terms.length === 0 || terms.some(term => title.includes(term));
      if (titleMatches) {
        mergedMap.set(key, {
          ...author,
          source: 'posts',
        });
      }
    }

    // Sort: by engagement, filter out small profiles (min 70 engagement)
    let sorted = Array.from(mergedMap.values())
      .filter(a => a.name && a.profileUrl && a.totalEngagement >= 70)
      .sort((a, b) => b.totalEngagement - a.totalEngagement)
      .slice(0, 15);

    console.log(`Final influencer list: ${sorted.length} (after min 70 engagement filter)`);

    console.log(`Final influencer list: ${sorted.length} (sources: ${sorted.map(a => a.source).join(', ')})`);

    // Format posts for display — ONLY high engagement posts
    const allPosts = postSearchResults
      .filter(p => p && (p.text || p.postText || p.content))
      .map(p => {
        const eng = (p.engagement && typeof p.engagement === 'object') ? p.engagement : {};
        const author = (p.author && typeof p.author === 'object') ? p.author : {};
        return {
          authorName: p.authorName || author.name || '',
          authorUrl: p.authorProfileUrl || author.linkedinUrl || author.url || '',
          text: String(p.text || p.postText || p.content || '').slice(0, 500),
          likes: Number(p.likesCount || eng.likes || p.reactions || p.numLikes) || 0,
          comments: Number(p.commentsCount || eng.comments || p.numComments) || 0,
          reposts: Number(p.repostsCount || eng.shares || p.numReposts) || 0,
          postUrl: p.postUrl || p.linkedinUrl || p.url || '',
          postedAt: (p.postedAt && p.postedAt.date) || p.postedAt || p.publishedAt || '',
        };
      })
      .map(p => ({ ...p, engagement: p.likes + p.comments * 3 + p.reposts * 2 }))
      // Filter: only show posts with strong engagement
      .filter(p => p.likes >= 100 || p.comments >= 30 || p.reposts >= 10)
      .sort((a, b) => b.engagement - a.engagement)
      .slice(0, 5);

    // Save to cache
    await saveNicheCache(cacheKey, sorted, allPosts);

    res.json({ profiles: sorted, posts: allPosts, fromCache: false });

  } catch (err) {
    console.error('Influencer error:', err.message, err.stack);
    // Only show errors we explicitly wrote for users. Everything else is technical.
    const safePrefixes = [
      'We couldn\'t find influencers',
      'Daily search limit reached',
    ];
    const isSafe = safePrefixes.some(prefix => (err.message || '').startsWith(prefix));
    const userMessage = isSafe
      ? err.message
      : 'Something went wrong on our end. Please try again in a moment, or try different keywords.';
    res.status(500).json({ error: userMessage });
  }
});

// =============================================
// API: Get industry influencers (pre-built data)
// =============================================
app.get('/api/industry/:slug', async (req, res) => {
  const { slug } = req.params;

  try {
    // Try to get from Supabase industry_influencers table
    const profiles = await supabaseQuery('GET', 'industry_influencers', {
      'industry': `eq.${slug}`,
      'select': '*',
      'order': 'total_engagement.desc',
    });

    if (!profiles || profiles.length === 0) {
      return res.status(404).json({ error: 'This industry is coming soon. We\'re building the influencer list.' });
    }

    // Filter out company/school/showcase pages — only show individual profiles
    // An individual profile URL looks like linkedin.com/in/xxx
    // Companies: /company/, /school/, /showcase/
    const companyUrlRe = /linkedin\.com\/(company|school|showcase|pulse)\//i;
    const individualProfiles = profiles.filter(p => {
      const url = p.profile_url || '';
      if (companyUrlRe.test(url)) return false;
      // Filter rows where title is just a follower count (company-page signature)
      const title = (p.title || '').trim();
      if (/^\s*[\d,]+\s*(followers?|subscribers?)\s*$/i.test(title)) return false;
      // Filter rows with no URL, no title, and no image (junk from failed scrapes)
      if (!url && !title && !p.profile_image) return false;
      return true;
    });

    // Deduplicate by name (case-insensitive). Prefer rows that have a profile_url,
    // and within that group keep the highest-engagement row.
    const byName = new Map();
    const hasUrl = (p) => !!(p && p.profile_url && String(p.profile_url).startsWith('http'));
    for (const p of individualProfiles) {
      const key = (p.name || '').trim().toLowerCase();
      if (!key) continue;
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, p);
        continue;
      }
      // If only one side has a URL, keep that one
      if (hasUrl(p) && !hasUrl(existing)) {
        byName.set(key, p);
        continue;
      }
      if (!hasUrl(p) && hasUrl(existing)) continue;
      // Same URL-status: keep higher engagement
      if ((p.total_engagement || 0) > (existing.total_engagement || 0)) {
        byName.set(key, p);
      }
    }
    const dedupedProfiles = Array.from(byName.values())
      .sort((a, b) => (b.total_engagement || 0) - (a.total_engagement || 0));

    // Clean trailing "LinkedIn" markers from title/text (residue from docx links
    // that were flattened into plain text during parsing).
    const stripLinkedInTail = (s) => {
      if (!s) return '';
      let out = String(s);
      // Remove trailing variants like " LinkedIn", " ( LinkedIn )", " | LinkedIn", ". LinkedIn"
      out = out.replace(/[\s.,;:|]*\(?\s*LinkedIn\s*(?:Profile)?\s*\)?\s*$/i, '');
      // Remove inline "( LinkedIn )" tokens that appear at end of sentences
      out = out.replace(/\s*\(\s*LinkedIn\s*\)\s*$/i, '');
      return out.trim();
    };

    // Format profiles for the frontend
    const formattedProfiles = dedupedProfiles.map(p => ({
      name: stripLinkedInTail(p.name),
      title: stripLinkedInTail(p.title || ''),
      profileUrl: p.profile_url || '',
      profileImage: p.profile_image || '',
      totalEngagement: p.total_engagement || 0,
    }));

    // Try to get cached posts for this industry. Fetch a large window so we can
    // dedupe properly — some posts have been refreshed with more accurate (and
    // often lower) engagement stats, which would otherwise be pushed past a
    // narrow top-N window.
    const cachedPosts = await supabaseQuery('GET', 'industry_posts', {
      'industry': `eq.${slug}`,
      'select': '*',
      'order': 'engagement.desc',
      'limit': '200',
    });

    // Dedupe: group by text prefix (since old scrapes split the same post into
    // two rows — one with author+URL, one without). Fall back to post_url only
    // when text is missing. Prefer rows that have both author_name and post_url,
    // and among those prefer the NEWEST row (highest id) — refresh-posts inserts
    // fresh engagement data as new rows, so newer = more accurate stats.
    const byPostKey = new Map();
    const scorePost = (p) => (p.author_name ? 1e6 : 0) + (p.post_url ? 1e6 : 0) + (p.id || 0);
    for (const p of (cachedPosts || [])) {
      const textKey = (p.text || '').trim().slice(0, 80).toLowerCase();
      const key = textKey || (p.post_url && p.post_url.trim()) || '';
      if (!key) continue;
      const existing = byPostKey.get(key);
      if (!existing || scorePost(p) > scorePost(existing)) {
        byPostKey.set(key, p);
      }
    }
    const dedupedPosts = Array.from(byPostKey.values())
      .sort((a, b) => (b.engagement || 0) - (a.engagement || 0))
      .slice(0, 5);

    const formattedPosts = dedupedPosts.map(p => ({
      authorName: stripLinkedInTail(p.author_name || ''),
      text: stripLinkedInTail(p.text || ''),
      likes: p.likes || 0,
      comments: p.comments || 0,
      reposts: p.reposts || 0,
      postUrl: p.post_url || '',
    }));

    res.json({ profiles: formattedProfiles, posts: formattedPosts });

  } catch (err) {
    console.error('Industry endpoint error:', err.message);
    res.status(500).json({ error: 'Something went wrong loading this industry.' });
  }
});

// =============================================
// API: Update industry profiles + add posts (admin)
// =============================================
app.post('/api/admin/update-profiles', async (req, res) => {
  const { industry, profiles, posts } = req.body;
  if (!industry) return res.status(400).json({ error: 'industry required' });

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_ANON_KEY;
  if (!sbUrl || !sbKey) return res.status(500).json({ error: 'Supabase not configured' });

  let updatedProfiles = 0;
  let addedProfiles = 0;
  let addedPosts = 0;
  let patchFailures = [];
  let patchStatuses = [];

  // Helper: accept both camelCase and snake_case
  const getUrl = (p) => p.profileUrl || p.profile_url || '';
  const getImg = (p) => p.profileImage || p.profile_image || '';
  const getEng = (p) => p.totalEngagement || p.total_engagement || 0;
  const getPostUrl = (p) => p.postUrl || p.post_url || '';
  const getAuthor = (p) => p.authorName || p.author_name || '';

  // Update or add profiles
  for (const p of (profiles || [])) {
    if (!p.name) continue;

    // Check if row exists (GET) — get ALL matching rows so we update every duplicate
    const existing = await supabaseQuery('GET', 'industry_influencers', {
      'name': `eq.${p.name}`,
      'industry': `eq.${industry}`,
      'select': 'id',
    });

    if (existing && existing.length > 0) {
      // Try PATCH first — may no-op silently if RLS blocks UPDATE on anon key
      const patchRes = await fetch(
        `${sbUrl}/rest/v1/industry_influencers?name=eq.${encodeURIComponent(p.name)}&industry=eq.${encodeURIComponent(industry)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': sbKey,
            'Authorization': `Bearer ${sbKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
          },
          body: JSON.stringify({
            title: p.title || '',
            profile_url: getUrl(p),
            profile_image: getImg(p),
            total_engagement: getEng(p),
          }),
        }
      );
      const patchText = await patchRes.text();
      let rowsReturned = 0;
      try { rowsReturned = JSON.parse(patchText).length || 0; } catch (_) {}
      patchStatuses.push({ name: p.name, status: patchRes.status, rowsReturned, body: patchText.slice(0, 200) });

      if (rowsReturned === existing.length) {
        updatedProfiles += rowsReturned;
      } else {
        // PATCH did nothing (RLS blocks UPDATE on anon key). Fall back:
        // DELETE the stale rows and INSERT a fresh row with the correct URL.
        // Preserve the best existing profile_image (so we don't lose Apify-scraped images).
        const fullExisting = await supabaseQuery('GET', 'industry_influencers', {
          'name': `eq.${p.name}`,
          'industry': `eq.${industry}`,
          'select': '*',
        });
        let existingImg = '';
        let existingEng = 0;
        for (const row of (fullExisting || [])) {
          if (row.profile_image && !existingImg) existingImg = row.profile_image;
          if ((row.total_engagement || 0) > existingEng) existingEng = row.total_engagement || 0;
        }
        let deletedN = 0;
        for (const row of (fullExisting || [])) {
          const delRes = await fetch(`${sbUrl}/rest/v1/industry_influencers?id=eq.${row.id}`, {
            method: 'DELETE',
            headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` },
          });
          if (delRes.ok) deletedN++;
        }
        const insertRes = await fetch(`${sbUrl}/rest/v1/industry_influencers`, {
          method: 'POST',
          headers: {
            'apikey': sbKey,
            'Authorization': `Bearer ${sbKey}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation',
          },
          body: JSON.stringify({
            industry,
            name: p.name,
            title: p.title || '',
            profile_url: getUrl(p),
            profile_image: getImg(p) || existingImg || '',
            total_engagement: Math.max(getEng(p), existingEng),
            created_at: new Date().toISOString(),
          }),
        });
        const insertText = await insertRes.text();
        if (insertRes.ok) {
          updatedProfiles += 1;
          patchStatuses.push({ name: p.name, note: 'delete+insert', deletedN });
        } else {
          patchFailures.push({ name: p.name, status: 'delete+insert failed', deletedN, insertStatus: insertRes.status, insertBody: insertText.slice(0, 300) });
        }
      }
    } else {
      // Insert new row
      const result = await supabaseQuery('POST', 'industry_influencers', {
        body: {
          industry,
          name: p.name,
          title: p.title || '',
          profile_url: getUrl(p),
          profile_image: getImg(p),
          total_engagement: getEng(p),
          created_at: new Date().toISOString(),
        },
      });
      if (result) addedProfiles++;
    }
  }

  // Add posts (dedupe by author + post_url)
  for (const post of (posts || [])) {
    const postUrl = getPostUrl(post);
    const author = getAuthor(post);

    // Skip if an identical post_url already exists for this industry
    if (postUrl) {
      const existingPost = await supabaseQuery('GET', 'industry_posts', {
        'industry': `eq.${industry}`,
        'post_url': `eq.${postUrl}`,
        'select': 'id',
        'limit': '1',
      });
      if (existingPost && existingPost.length > 0) continue;
    }

    const result = await supabaseQuery('POST', 'industry_posts', {
      body: {
        industry,
        author_name: author,
        text: post.text || '',
        likes: post.likes || 0,
        comments: post.comments || 0,
        reposts: post.reposts || 0,
        engagement: (post.likes || 0) + (post.comments || 0) * 3 + (post.reposts || 0) * 2,
        post_url: postUrl,
        created_at: new Date().toISOString(),
      },
    });
    if (result) addedPosts++;
  }

  res.json({ success: true, updatedProfiles, addedProfiles, addedPosts, patchFailures: patchFailures.slice(0, 10), patchStatusSample: patchStatuses.slice(0, 3) });
});

// =============================================
// API: Dedupe industry (admin) — keeps highest-engagement row per name
// =============================================
// Admin: inspect raw rows for an industry (diagnostic)
app.get('/api/admin/inspect/:slug', async (req, res) => {
  const slug = req.params.slug;
  try {
    const profiles = await supabaseQuery('GET', 'industry_influencers', {
      'industry': `eq.${slug}`,
      'select': '*',
      'order': 'name.asc',
    });
    res.json({ count: profiles?.length || 0, profiles: profiles || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/inspect-posts/:slug', async (req, res) => {
  const slug = req.params.slug;
  try {
    const posts = await supabaseQuery('GET', 'industry_posts', {
      'industry': `eq.${slug}`,
      'select': '*',
      'order': 'engagement.desc',
    });
    res.json({ count: posts?.length || 0, posts: posts || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: refresh post engagement stats via Apify (by post URL)
// Body: { industry: "slug", actor?: "actorId", inputKey?: "postUrls"|"urls"|"startUrls", maxChargeUsd?: 0.5, limit?: 5 }
app.post('/api/admin/refresh-posts', async (req, res) => {
  const { industry, actor, inputKey, maxChargeUsd, limit } = req.body;
  if (!industry) return res.status(400).json({ error: 'industry required' });

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_ANON_KEY;
  if (!sbUrl || !sbKey) return res.status(500).json({ error: 'Supabase not configured' });

  try {
    // Fetch top posts for this industry
    const allPosts = await supabaseQuery('GET', 'industry_posts', {
      'industry': `eq.${industry}`,
      'select': '*',
      'order': 'engagement.desc',
      'limit': '50',
    });

    if (!allPosts || allPosts.length === 0) {
      return res.json({ success: false, reason: 'no posts for this industry' });
    }

    // Keep only those with a linkedin URL, dedupe by URL, cap at requested limit
    const seen = new Set();
    const posts = [];
    for (const p of allPosts) {
      const u = p.post_url || '';
      if (!u || !/linkedin\.com/.test(u)) continue;
      if (seen.has(u)) continue;
      seen.add(u);
      posts.push(p);
      if (posts.length >= (limit || 10)) break;
    }

    if (posts.length === 0) return res.json({ success: false, reason: 'no posts with linkedin URLs' });
    const postUrls = posts.map(p => p.post_url);
    if (postUrls.length === 0) return res.json({ success: false, reason: 'no valid linkedin urls' });

    const actorId = actor || 'harvestapi~linkedin-post';
    const key = inputKey || 'postUrls';
    const input = {};
    if (key === 'startUrls') {
      input.startUrls = postUrls.map(u => ({ url: u }));
    } else {
      input[key] = postUrls;
    }

    console.log(`refresh-posts: actor=${actorId} inputKey=${key} count=${postUrls.length}`);
    const items = await runApifyActor(actorId, input, maxChargeUsd || 0.5).catch(e => ({ error: e.message }));

    if (items && items.error) {
      return res.json({ success: false, actor: actorId, inputKey: key, error: items.error });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.json({ success: false, actor: actorId, inputKey: key, reason: 'no items returned', sampleInput: input });
    }

    // Build URL -> fresh-stats map
    const normalize = (u) => String(u || '').split('?')[0].replace(/\/$/, '').toLowerCase();
    const freshByUrl = new Map();
    for (const it of items) {
      // Try multiple URL fields
      const url = it.url || it.postUrl || it.linkedinUrl || it.shareUrl || (it.post && it.post.url) || '';
      if (!url) continue;
      const eng = it.engagement || it.stats || it.reactions || {};
      const likes = Number(eng.likes ?? eng.reactions ?? eng.reactionsCount ?? it.numLikes ?? it.likesCount ?? it.totalReactions ?? 0) || 0;
      const comments = Number(eng.comments ?? eng.commentsCount ?? it.numComments ?? it.commentsCount ?? 0) || 0;
      const reposts = Number(eng.shares ?? eng.reposts ?? eng.repostsCount ?? eng.sharesCount ?? it.numShares ?? it.sharesCount ?? it.repostsCount ?? 0) || 0;
      freshByUrl.set(normalize(url), { likes, comments, reposts });
    }

    // Apply updates
    let updated = 0;
    const details = [];
    for (const post of posts) {
      const fresh = freshByUrl.get(normalize(post.post_url));
      if (!fresh) {
        details.push({ url: post.post_url, status: 'no-match' });
        continue;
      }
      const newEng = fresh.likes + fresh.comments * 3 + fresh.reposts * 2;
      // Try PATCH
      const patchRes = await fetch(`${sbUrl}/rest/v1/industry_posts?id=eq.${post.id}`, {
        method: 'PATCH',
        headers: {
          'apikey': sbKey,
          'Authorization': `Bearer ${sbKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation',
        },
        body: JSON.stringify({
          likes: fresh.likes,
          comments: fresh.comments,
          reposts: fresh.reposts,
          engagement: newEng,
        }),
      });
      const patchText = await patchRes.text();
      let rows = 0;
      try { rows = JSON.parse(patchText).length || 0; } catch (_) {}

      if (rows > 0) {
        updated++;
        details.push({ url: post.post_url, status: 'updated', before: { likes: post.likes, comments: post.comments, reposts: post.reposts }, after: fresh });
      } else {
        // RLS fallback: delete+insert
        const delRes = await fetch(`${sbUrl}/rest/v1/industry_posts?id=eq.${post.id}`, {
          method: 'DELETE',
          headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` },
        });
        if (delRes.ok) {
          const insertRes = await fetch(`${sbUrl}/rest/v1/industry_posts`, {
            method: 'POST',
            headers: {
              'apikey': sbKey,
              'Authorization': `Bearer ${sbKey}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=representation',
            },
            body: JSON.stringify({
              industry: post.industry,
              author_name: post.author_name,
              text: post.text,
              likes: fresh.likes,
              comments: fresh.comments,
              reposts: fresh.reposts,
              engagement: newEng,
              post_url: post.post_url,
              created_at: post.created_at || new Date().toISOString(),
            }),
          });
          if (insertRes.ok) {
            updated++;
            details.push({ url: post.post_url, status: 'delete+insert', before: { likes: post.likes, comments: post.comments, reposts: post.reposts }, after: fresh });
          } else {
            const ib = await insertRes.text();
            details.push({ url: post.post_url, status: 'insert-fail', body: ib.slice(0, 200) });
          }
        } else {
          details.push({ url: post.post_url, status: 'delete-fail' });
        }
      }
    }

    res.json({
      success: true,
      industry,
      actor: actorId,
      inputKey: key,
      itemsReturned: items.length,
      postsAttempted: posts.length,
      updated,
      details,
    });
  } catch (err) {
    console.error('refresh-posts error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/dedupe-industry', async (req, res) => {
  const { industry } = req.body;
  if (!industry) return res.status(400).json({ error: 'industry required' });

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_ANON_KEY;
  if (!sbUrl || !sbKey) return res.status(500).json({ error: 'Supabase not configured' });

  try {
    const profiles = await supabaseQuery('GET', 'industry_influencers', {
      'industry': `eq.${industry}`,
      'select': '*',
      'order': 'total_engagement.desc',
    });

    // Group by name (case-insensitive), keep highest-engagement row (first per desc sort)
    const byName = new Map();
    const toDelete = [];
    for (const p of (profiles || [])) {
      const key = (p.name || '').trim().toLowerCase();
      if (!key) continue;
      if (byName.has(key)) {
        toDelete.push(p.id);
      } else {
        byName.set(key, p.id);
      }
    }

    let deletedProfiles = 0;
    for (const id of toDelete) {
      const delRes = await fetch(`${sbUrl}/rest/v1/industry_influencers?id=eq.${id}`, {
        method: 'DELETE',
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` },
      });
      if (delRes.ok) deletedProfiles++;
    }

    // Dedupe posts by (author_name, post_url or text prefix)
    const posts = await supabaseQuery('GET', 'industry_posts', {
      'industry': `eq.${industry}`,
      'select': '*',
      'order': 'engagement.desc',
    });
    const byPost = new Map();
    const postsToDelete = [];
    for (const p of (posts || [])) {
      const key = `${(p.author_name || '').toLowerCase()}|${p.post_url || (p.text || '').slice(0, 60)}`;
      if (byPost.has(key)) {
        postsToDelete.push(p.id);
      } else {
        byPost.set(key, p.id);
      }
    }
    let deletedPosts = 0;
    for (const id of postsToDelete) {
      const delRes = await fetch(`${sbUrl}/rest/v1/industry_posts?id=eq.${id}`, {
        method: 'DELETE',
        headers: { 'apikey': sbKey, 'Authorization': `Bearer ${sbKey}` },
      });
      if (delRes.ok) deletedPosts++;
    }

    res.json({
      success: true,
      totalProfiles: profiles?.length || 0,
      uniqueProfiles: byName.size,
      deletedProfiles,
      totalPosts: posts?.length || 0,
      uniquePosts: byPost.size,
      deletedPosts,
    });
  } catch (err) {
    console.error('Dedupe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// API: Copy industry slug (admin) — inserts duplicate rows under new slug
// =============================================
app.post('/api/admin/copy-industry', async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  try {
    const profiles = await supabaseQuery('GET', 'industry_influencers', {
      'industry': `eq.${from}`,
      'select': '*',
    });
    const posts = await supabaseQuery('GET', 'industry_posts', {
      'industry': `eq.${from}`,
      'select': '*',
    });

    let copiedProfiles = 0;
    for (const p of (profiles || [])) {
      const r = await supabaseQuery('POST', 'industry_influencers', {
        body: {
          industry: to,
          name: p.name,
          title: p.title || '',
          profile_url: p.profile_url || '',
          profile_image: p.profile_image || '',
          total_engagement: p.total_engagement || 0,
          created_at: new Date().toISOString(),
        },
      });
      if (r) copiedProfiles++;
    }

    let copiedPosts = 0;
    for (const p of (posts || [])) {
      const r = await supabaseQuery('POST', 'industry_posts', {
        body: {
          industry: to,
          author_name: p.author_name || '',
          text: p.text || '',
          likes: p.likes || 0,
          comments: p.comments || 0,
          reposts: p.reposts || 0,
          engagement: p.engagement || 0,
          post_url: p.post_url || '',
          created_at: new Date().toISOString(),
        },
      });
      if (r) copiedPosts++;
    }

    res.json({ success: true, copiedProfiles, copiedPosts, sourceProfiles: profiles?.length || 0, sourcePosts: posts?.length || 0 });
  } catch (err) {
    console.error('Copy industry error:', err.message);
    res.status(500).json({ error: err.message });
  }
});


// =============================================
// API: Seed industry data (admin endpoint)
// =============================================
app.post('/api/admin/seed-industry', async (req, res) => {
  const { industry, influencers } = req.body;
  if (!industry || !Array.isArray(influencers)) {
    return res.status(400).json({ error: 'industry and influencers[] required' });
  }

  try {
    let saved = 0;
    for (const person of influencers) {
      const result = await supabaseQuery('POST', 'industry_influencers', {
        body: {
          industry,
          name: person.name || '',
          profile_url: person.profileUrl || person.profile_url || '',
          title: person.title || '',
          profile_image: person.profileImage || person.profile_image || '',
          total_engagement: person.totalEngagement || person.total_engagement || 0,
          created_at: new Date().toISOString(),
        },
      });
      if (result) saved++;
    }

    res.json({ success: true, saved, total: influencers.length });
  } catch (err) {
    console.error('Seed error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// API: Build/populate an industry from post search
// =============================================
const INDUSTRY_KEYWORDS = {
  'content-marketing-copywriting': ['content marketing', 'copywriting', 'content strategy'],
  'it-services': ['IT services', 'managed IT', 'IT consulting'],
  'software-development': ['software development', 'software engineering', 'coding best practices'],
  'technology-internet': ['technology trends', 'tech innovation', 'digital transformation'],
  'business-consulting': ['business consulting', 'business strategy', 'management consulting'],
  'finance': ['finance', 'financial planning', 'corporate finance'],
  'marketing': ['marketing strategy', 'digital marketing', 'brand marketing'],
  'advertising': ['advertising', 'ad campaigns', 'media buying'],
  'education': ['education', 'edtech', 'teaching innovation'],
  'higher-education': ['higher education', 'university leadership', 'academic research'],
  'human-resources': ['human resources', 'HR strategy', 'people operations'],
  'entrepreneurship-startups': ['startup founder', 'entrepreneurship', 'startup growth'],
  'sales-business-development': ['sales strategy', 'B2B sales', 'business development'],
  'venture-capital-investing': ['venture capital', 'startup investing', 'VC insights'],
  'executive-coaching-leadership': ['executive coaching', 'leadership development', 'leadership tips'],
  'artificial-intelligence': ['artificial intelligence', 'AI trends', 'machine learning'],
  'healthcare-healthtech': ['healthcare', 'health tech', 'digital health'],
  'real-estate': ['real estate', 'commercial real estate', 'property investment'],
  'ecommerce': ['ecommerce', 'DTC brands', 'online retail'],
  'sustainability-clean-energy': ['sustainability', 'clean energy', 'ESG'],
  'recruitment-talent-acquisition': ['recruitment', 'talent acquisition', 'hiring strategy'],
  'product-management': ['product management', 'product strategy', 'product leadership'],
  'public-relations-communications': ['public relations', 'PR strategy', 'corporate communications'],
  'supply-chain-logistics': ['supply chain', 'logistics', 'operations management'],
  'cybersecurity': ['cybersecurity', 'information security', 'cyber threats'],
  'legal-legaltech': ['legal tech', 'law practice', 'legal innovation'],
  'management-consulting': ['management consulting', 'strategy consulting', 'consulting insights'],
  'nonprofit-social-impact': ['nonprofit', 'social impact', 'social enterprise'],
  'design-ux-creative': ['UX design', 'product design', 'creative direction'],
};

app.post('/api/admin/build-industry', async (req, res) => {
  const { industry } = req.body;
  if (!industry) return res.status(400).json({ error: 'industry slug required' });

  const searchTerms = INDUSTRY_KEYWORDS[industry];
  if (!searchTerms) return res.status(400).json({ error: `Unknown industry: ${industry}` });

  try {
    console.log(`Building industry "${industry}" with keywords: ${JSON.stringify(searchTerms)}`);

    const postResults = await runApifyActor('harvestapi~linkedin-post-search', {
      searchQueries: searchTerms,
      maxPosts: 100,
    }, 0.25).catch(e => { console.log('Post search failed:', e.message); return []; });

    if (!Array.isArray(postResults) || postResults.length === 0) {
      return res.json({ success: false, profiles: 0, posts: 0, message: 'Post search returned no results' });
    }

    console.log(`Got ${postResults.length} posts for "${industry}"`);

    // Filter hiring posts
    const hiringWords = /\b(hiring|we're looking for|job opening|job opportunity|apply now|join our team|we are hiring|work from home job|urgent\s*hiring|remote job)\b/i;
    const cleanPosts = postResults.filter(p => {
      if (!p || typeof p !== 'object') return false;
      const text = String(p.text || p.postText || p.content || '');
      return !hiringWords.test(text);
    });

    // Build engagement map — aggregate by author
    const engagementMap = new Map();
    for (const post of cleanPosts) {
      const author = post.author || {};
      const authorKey = author.publicIdentifier || author.universalName || author.name;
      if (!authorKey) continue;

      if (!engagementMap.has(authorKey)) {
        const avatarObj = (author.avatar && typeof author.avatar === 'object') ? author.avatar : {};
        engagementMap.set(authorKey, {
          name: author.name || '',
          title: author.info || author.position || author.headline || author.description || '',
          profileUrl: author.linkedinUrl || author.url || (author.publicIdentifier ? `https://www.linkedin.com/in/${author.publicIdentifier}` : ''),
          profileImage: avatarObj.url || '',
          totalEngagement: 0,
          postCount: 0,
        });
      }

      const a = engagementMap.get(authorKey);
      const eng = (post.engagement && typeof post.engagement === 'object') ? post.engagement : {};
      const postEng = (Number(eng.likes) || 0) + (Number(eng.comments) || 0) * 3 + (Number(eng.shares) || 0) * 2;
      a.totalEngagement += postEng;
      a.postCount += 1;
    }

    // Filter: 70+ engagement, sort by engagement
    const topAuthors = Array.from(engagementMap.values())
      .filter(a => a.name && a.profileUrl && a.totalEngagement >= 70)
      .sort((a, b) => b.totalEngagement - a.totalEngagement);

    console.log(`${topAuthors.length} authors with 70+ engagement for "${industry}"`);

    // Save authors to industry_influencers
    let savedProfiles = 0;
    for (const author of topAuthors) {
      const result = await supabaseQuery('POST', 'industry_influencers', {
        body: {
          industry,
          name: author.name,
          title: author.title,
          profile_url: author.profileUrl,
          profile_image: author.profileImage,
          total_engagement: author.totalEngagement,
          created_at: new Date().toISOString(),
        },
      });
      if (result) savedProfiles++;
    }

    // Save top posts (all with strong engagement)
    let savedPosts = 0;
    const topPosts = cleanPosts
      .filter(p => p && (p.text || p.postText || p.content))
      .map(p => {
        const eng = (p.engagement && typeof p.engagement === 'object') ? p.engagement : {};
        const author = (p.author && typeof p.author === 'object') ? p.author : {};
        const likes = Number(eng.likes || p.likesCount || 0);
        const comments = Number(eng.comments || p.commentsCount || 0);
        const reposts = Number(eng.shares || p.repostsCount || 0);
        return {
          authorName: author.name || p.authorName || '',
          text: String(p.text || p.postText || p.content || '').slice(0, 500),
          likes, comments, reposts,
          engagement: likes + comments * 3 + reposts * 2,
          postUrl: p.postUrl || p.linkedinUrl || p.url || '',
        };
      })
      .filter(p => p.likes >= 100 || p.comments >= 30 || p.reposts >= 10)
      .sort((a, b) => b.engagement - a.engagement);

    for (const post of topPosts) {
      const result = await supabaseQuery('POST', 'industry_posts', {
        body: {
          industry,
          author_name: post.authorName,
          text: post.text,
          likes: post.likes,
          comments: post.comments,
          reposts: post.reposts,
          engagement: post.engagement,
          post_url: post.postUrl,
          created_at: new Date().toISOString(),
        },
      });
      if (result) savedPosts++;
    }

    console.log(`Industry "${industry}" done: ${savedProfiles} profiles, ${savedPosts} posts`);
    res.json({ success: true, profiles: savedProfiles, posts: savedPosts });

  } catch (err) {
    console.error('Build industry error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Batch: build multiple industries at once
app.post('/api/admin/build-industries-batch', async (req, res) => {
  const { industries } = req.body;
  if (!Array.isArray(industries)) return res.status(400).json({ error: 'industries[] required' });

  const results = {};
  // Process 2 at a time to avoid overloading
  for (let i = 0; i < industries.length; i += 2) {
    const batch = industries.slice(i, i + 2);
    const batchResults = await Promise.all(batch.map(async (slug) => {
      try {
        const searchTerms = INDUSTRY_KEYWORDS[slug];
        if (!searchTerms) return { slug, error: 'Unknown industry' };

        console.log(`[Batch] Building "${slug}"...`);
        const postResults = await runApifyActor('harvestapi~linkedin-post-search', {
          searchQueries: searchTerms,
          maxPosts: 100,
        }, 0.25).catch(e => []);

        if (!Array.isArray(postResults) || postResults.length === 0) {
          return { slug, profiles: 0, posts: 0 };
        }

        const hiringWords = /\b(hiring|we're looking for|job opening|job opportunity|apply now|join our team|we are hiring|work from home job|urgent\s*hiring|remote job)\b/i;
        const cleanPosts = postResults.filter(p => {
          if (!p || typeof p !== 'object') return false;
          return !hiringWords.test(String(p.text || p.postText || p.content || ''));
        });

        const engagementMap = new Map();
        for (const post of cleanPosts) {
          const author = post.author || {};
          const authorKey = author.publicIdentifier || author.universalName || author.name;
          if (!authorKey) continue;

          if (!engagementMap.has(authorKey)) {
            const avatarObj = (author.avatar && typeof author.avatar === 'object') ? author.avatar : {};
            engagementMap.set(authorKey, {
              name: author.name || '',
              title: author.info || author.position || author.headline || author.description || '',
              profileUrl: author.linkedinUrl || author.url || (author.publicIdentifier ? `https://www.linkedin.com/in/${author.publicIdentifier}` : ''),
              profileImage: avatarObj.url || '',
              totalEngagement: 0,
            });
          }
          const a = engagementMap.get(authorKey);
          const eng = (post.engagement && typeof post.engagement === 'object') ? post.engagement : {};
          a.totalEngagement += (Number(eng.likes) || 0) + (Number(eng.comments) || 0) * 3 + (Number(eng.shares) || 0) * 2;
        }

        const topAuthors = Array.from(engagementMap.values())
          .filter(a => a.name && a.profileUrl && a.totalEngagement >= 70)
          .sort((a, b) => b.totalEngagement - a.totalEngagement);

        let savedProfiles = 0;
        for (const author of topAuthors) {
          const r = await supabaseQuery('POST', 'industry_influencers', {
            body: { industry: slug, name: author.name, title: author.title, profile_url: author.profileUrl, profile_image: author.profileImage, total_engagement: author.totalEngagement, created_at: new Date().toISOString() },
          });
          if (r) savedProfiles++;
        }

        let savedPosts = 0;
        const topPosts = cleanPosts
          .filter(p => p && (p.text || p.postText || p.content))
          .map(p => {
            const eng = (p.engagement && typeof p.engagement === 'object') ? p.engagement : {};
            const author = (p.author && typeof p.author === 'object') ? p.author : {};
            const likes = Number(eng.likes || p.likesCount || 0);
            const comments = Number(eng.comments || p.commentsCount || 0);
            const reposts = Number(eng.shares || p.repostsCount || 0);
            return { authorName: author.name || '', text: String(p.text || p.postText || p.content || '').slice(0, 500), likes, comments, reposts, engagement: likes + comments * 3 + reposts * 2, postUrl: p.postUrl || p.linkedinUrl || p.url || '' };
          })
          .filter(p => p.likes >= 100 || p.comments >= 30 || p.reposts >= 10)
          .sort((a, b) => b.engagement - a.engagement);

        for (const post of topPosts) {
          const r = await supabaseQuery('POST', 'industry_posts', {
            body: { industry: slug, author_name: post.authorName, text: post.text, likes: post.likes, comments: post.comments, reposts: post.reposts, engagement: post.engagement, post_url: post.postUrl, created_at: new Date().toISOString() },
          });
          if (r) savedPosts++;
        }

        return { slug, profiles: savedProfiles, posts: savedPosts };
      } catch (e) {
        return { slug, error: e.message };
      }
    }));

    for (const r of batchResults) results[r.slug] = r;
  }

  res.json({ success: true, results });
});

// =============================================
// API: Generate post ideas
// =============================================
app.post('/api/post-ideas', async (req, res) => {
  const { niche, role, goal, topPosts, profiles } = req.body;

  const topPostsSummary = (topPosts || []).slice(0, 5).map((p, i) =>
    `Post ${i + 1} (${p.likes} likes, ${p.comments} comments, ${p.reposts} reposts) by ${p.authorName}:\n"${p.text.slice(0, 300)}"\nURL: ${p.postUrl}`
  ).join('\n\n');

  const profilesSummary = (profiles || []).slice(0, 10).map(p =>
    `${p.name} — ${p.title} (${p.totalEngagement?.toLocaleString() || 0} engagement)`
  ).join('\n');

  const systemPrompt = `You are a LinkedIn content strategist. You analyze top-performing posts from real influencers and generate post ideas tailored to a user's niche.

Return ONLY a raw JSON array (no markdown, no backticks) of exactly 10 objects:
[
  {
    "hook": "The opening line of the post",
    "why": "Why this will work — reference which influencer post inspired it",
    "format": "Carousel / Story / List / How-to / Opinion / Hot Take / Thread",
    "reference_post_url": "URL of the inspiring post or empty string",
    "reference_author": "Name of the influencer whose post inspired this"
  }
]

Rules:
- Each idea MUST be inspired by a real top-performing post from the data
- Adapt the pattern/angle to the user's niche
- Vary formats: tactical, personal story, opinion, educational, hot takes
- Hooks must stop the scroll
- Reference the actual post URL when possible`;

  const userMsg = `Niche: ${niche}
${role ? `Role: ${role}` : ''}
${goal ? `Goal: ${goal}` : ''}

TOP INFLUENCERS:
${profilesSummary}

TOP POSTS (by engagement):
${topPostsSummary}

Generate 10 post ideas inspired by what's working.`;

  try {
    const data = await callAnthropic(systemPrompt, userMsg, 4000);
    const text = data.content[0].text;
    const cleaned = text.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
    const ideas = JSON.parse(cleaned);
    res.json({ ideas });
  } catch (err) {
    console.error('Post ideas error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// API: Analyze tone of voice from sample writing
// =============================================
app.post('/api/analyze-tone', async (req, res) => {
  const { sampleText } = req.body;
  if (!sampleText || sampleText.trim().length < 50) {
    return res.status(400).json({ error: 'Please paste at least a few sentences of your writing.' });
  }

  try {
    const data = await callAnthropic(
      `You analyze writing samples and extract the author's unique tone of voice. Return a concise tone profile (3-5 bullet points) describing their style. Focus on: sentence length, formality level, use of stories vs data, humor, vocabulary complexity, and any distinctive patterns. Be specific and actionable — a ghostwriter should be able to replicate this voice from your description. Return ONLY the bullet points, no intro or outro.`,
      `Analyze the tone of voice in this writing sample:\n\n"${sampleText.slice(0, 3000)}"`,
      800
    );
    const tone = data.content[0].text;
    res.json({ tone });
  } catch (err) {
    console.error('Tone analysis error:', err.message);
    res.status(500).json({ error: 'Could not analyze tone. Please try again.' });
  }
});

// =============================================
// API: Draft a post
// =============================================
app.post('/api/generate', async (req, res) => {
  try {
    const data = await callAnthropic(
      req.body.system || '',
      req.body.messages?.[0]?.content || '',
      req.body.max_tokens || 4000
    );
    res.json(data);
  } catch (err) {
    console.error('Generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`LinkedIn Influencer Finder running on port ${PORT}`);
});
