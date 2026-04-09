const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '200kb' }));
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
  const { niche } = req.body;
  if (!niche) return res.status(400).json({ error: 'Niche is required' });

  try {
    // Check cache first (doesn't count against rate limit)
    const cached = await getCachedNiche(niche);
    if (cached) {
      console.log(`Cache hit: ${niche}`);
      return res.json({
        profiles: JSON.parse(cached.profiles),
        posts: JSON.parse(cached.posts),
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

    let allPostsFromSearch = null; // May be populated by post-search fallback
    console.log(`Cache miss: ${niche}. Expanding keywords...`);

    // Step 0.5: Use Claude to generate smart LinkedIn search keywords
    let searchKeywords = niche;
    try {
      const kwData = await callAnthropic(
        `You help optimize LinkedIn people search queries. Given a niche, return 1-3 search keyword variations that would find the most active LinkedIn creators and thought leaders in that space. Return ONLY a JSON array of strings, no explanation. Example: ["B2B SaaS marketing leader", "SaaS growth strategist", "B2B content creator marketing"]`,
        `Niche: ${niche}\n\nGenerate 1-3 LinkedIn people search keyword variations to find top creators.`,
        500
      );
      const kwText = kwData.content[0].text.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();
      const keywords = JSON.parse(kwText);
      if (Array.isArray(keywords) && keywords.length > 0) {
        searchKeywords = keywords[0]; // Use the best one for the main search
        console.log('Expanded keywords:', keywords);
      }
    } catch (e) {
      console.log('Keyword expansion failed, using original niche:', e.message);
    }

    // Step 1: Search profiles via harvestapi
    // Actor input fields (from JSON tab): searchQuery, maxItems, profileScraperMode
    // Short mode = search results only (name, title, headline, URL) — profiles are FREE
    // Cost in Short mode: only $0.10 per search page (25 results), no per-profile charge
    const searchInput = {
      searchQuery: searchKeywords,
      maxItems: 25,
      profileScraperMode: 'short',  // Don't pay $0.004/profile — we only need basic data
    };
    console.log('Apify search input:', JSON.stringify(searchInput));

    let searchResults;
    try {
      // Budget: $0.12 (1 search page $0.10 + margin)
      searchResults = await runApifyActor('harvestapi~linkedin-profile-search', searchInput, 0.12);
      console.log(`harvestapi returned ${searchResults ? searchResults.length : 0} profiles`);
      if (searchResults && searchResults.length > 0) {
        console.log('First result keys:', Object.keys(searchResults[0]).join(', '));
        console.log('First result sample:', JSON.stringify(searchResults[0]).slice(0, 500));
      }
    } catch (e) {
      console.log('harvestapi profile-search failed:', e.message);
      searchResults = [];
    }

    // Fallback Strategy: Search POSTS instead of profiles
    // If profile search fails, search for viral posts in the niche
    // and extract author info — this is actually better for finding influencers
    if (!searchResults || searchResults.length === 0) {
      console.log('Profile search returned 0. Trying POST search approach...');
      try {
        const postSearchResults = await runApifyActor('harvestapi~linkedin-post-search', {
          searchQuery: searchKeywords,
          maxPosts: 50,
          sortBy: 'relevance',
        }, 0.25);

        console.log(`Post search returned ${postSearchResults ? postSearchResults.length : 0} posts`);

        if (postSearchResults && postSearchResults.length > 0) {
          console.log('First post keys:', Object.keys(postSearchResults[0]).join(', '));
          console.log('First post sample:', JSON.stringify(postSearchResults[0]).slice(0, 500));

          // Extract unique authors from posts as our "profiles"
          const authorMap = new Map();
          for (const post of postSearchResults) {
            const author = post.author || {};
            const authorKey = author.publicIdentifier || author.universalName || author.name;
            if (!authorKey) continue;

            if (!authorMap.has(authorKey)) {
              authorMap.set(authorKey, {
                name: author.name || '',
                title: author.info || author.position || '',
                profileUrl: author.linkedinUrl || (author.publicIdentifier ? `https://www.linkedin.com/in/${author.publicIdentifier}` : ''),
                followers: 0,
                location: '',
                totalEngagement: 0,
                postCount: 0,
              });
            }

            const a = authorMap.get(authorKey);
            const eng = post.engagement || {};
            a.totalEngagement += (eng.likes || 0) + (eng.comments || 0) * 3 + (eng.shares || 0) * 2;
            a.postCount += 1;
          }

          // Convert to profiles sorted by total engagement
          searchResults = Array.from(authorMap.values())
            .map(a => ({ ...a, followers: a.totalEngagement })) // Use engagement as proxy for influence
            .sort((a, b) => b.followers - a.followers);

          console.log(`Extracted ${searchResults.length} unique authors from posts`);

          // Also save the posts directly for later use
          allPostsFromSearch = postSearchResults;
        }
      } catch (e2) {
        console.log('Post search also failed:', e2.message);
      }
    }

    if (!searchResults || searchResults.length === 0) {
      throw new Error('No profiles found. Try broader keywords like "marketing" or "sales".');
    }

    // Log first result structure for debugging
    if (searchResults[0]) {
      console.log('Sample profile keys:', Object.keys(searchResults[0]).join(', '));
    }

    const sorted = searchResults
      .filter(p => (p.fullName || p.name || p.firstName) && (p.profileUrl || p.url || p.linkedinUrl || p.publicIdentifier))
      .map(p => ({
        name: p.fullName || p.name || [p.firstName, p.lastName].filter(Boolean).join(' ') || '',
        title: p.headline || p.position || p.title || p.occupation || '',
        profileUrl: p.profileUrl || p.url || p.linkedinUrl || (p.publicIdentifier ? `https://www.linkedin.com/in/${p.publicIdentifier}` : ''),
        followers: parseInt(p.followersCount || p.followers || p.followerCount || p.connectionsCount || 0),
        location: (typeof p.location === 'object' ? p.location?.linkedinText : p.location) || p.geo || '',
      }))
      .sort((a, b) => b.followers - a.followers)
      .slice(0, 20);

    // Step 2: Use post data from the post-search fallback (no extra API call)
    // If profile search worked (not post-search), we do a single cheap post search
    let allPosts = [];

    if (allPostsFromSearch && allPostsFromSearch.length > 0) {
      // Already have posts from the fallback strategy — use them directly
      console.log(`Using ${allPostsFromSearch.length} posts from post-search fallback`);
      allPosts = allPostsFromSearch
        .filter(p => p.text || p.postText || p.content)
        .map(p => ({
          authorName: p.authorName || p.author?.name || '',
          authorUrl: p.authorProfileUrl || p.author?.linkedinUrl || p.author?.url || '',
          text: (p.text || p.postText || p.content || '').slice(0, 500),
          likes: parseInt(p.likesCount || p.engagement?.likes || p.reactions || p.numLikes || 0),
          comments: parseInt(p.commentsCount || p.engagement?.comments || p.numComments || 0),
          reposts: parseInt(p.repostsCount || p.engagement?.shares || p.numReposts || 0),
          postUrl: p.postUrl || p.linkedinUrl || p.url || '',
          postedAt: p.postedAt?.date || p.postedAt || p.publishedAt || '',
        }))
        .map(p => ({ ...p, engagement: p.likes + p.comments * 3 + p.reposts * 2 }))
        .sort((a, b) => b.engagement - a.engagement)
        .slice(0, 50);
    } else if (sorted.length > 0) {
      // Profile search worked but we have no posts yet — do one cheap post search
      console.log('Fetching posts via post-search for the niche...');
      try {
        const postSearchResults = await runApifyActor('harvestapi~linkedin-post-search', {
          searchQuery: searchKeywords,
          maxPosts: 50,
          sortBy: 'relevance',
        }, 0.25);

        if (postSearchResults && postSearchResults.length > 0) {
          allPosts = postSearchResults
            .filter(p => p.text || p.postText || p.content)
            .map(p => ({
              authorName: p.authorName || p.author?.name || '',
              authorUrl: p.authorProfileUrl || p.author?.linkedinUrl || p.author?.url || '',
              text: (p.text || p.postText || p.content || '').slice(0, 500),
              likes: parseInt(p.likesCount || p.engagement?.likes || p.reactions || p.numLikes || 0),
              comments: parseInt(p.commentsCount || p.engagement?.comments || p.numComments || 0),
              reposts: parseInt(p.repostsCount || p.engagement?.shares || p.numReposts || 0),
              postUrl: p.postUrl || p.linkedinUrl || p.url || '',
              postedAt: p.postedAt?.date || p.postedAt || p.publishedAt || '',
            }))
            .map(p => ({ ...p, engagement: p.likes + p.comments * 3 + p.reposts * 2 }))
            .sort((a, b) => b.engagement - a.engagement)
            .slice(0, 50);
        }
      } catch (e) {
        console.log('Post search for content failed:', e.message);
      }
    }

    // Save to cache
    await saveNicheCache(niche, sorted, allPosts);

    res.json({ profiles: sorted, posts: allPosts, fromCache: false });

  } catch (err) {
    console.error('Influencer error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// API: Generate post ideas
// =============================================
app.post('/api/post-ideas', async (req, res) => {
  const { niche, role, goal, topPosts, profiles } = req.body;

  const topPostsSummary = (topPosts || []).slice(0, 20).map((p, i) =>
    `Post ${i + 1} (${p.likes} likes, ${p.comments} comments, ${p.reposts} reposts) by ${p.authorName}:\n"${p.text.slice(0, 300)}"\nURL: ${p.postUrl}`
  ).join('\n\n');

  const profilesSummary = (profiles || []).slice(0, 10).map(p =>
    `${p.name} — ${p.title} (${p.followers.toLocaleString()} followers)`
  ).join('\n');

  const systemPrompt = `You are a LinkedIn content strategist. You analyze top-performing posts from real influencers and generate post ideas tailored to a user's niche.

Return ONLY a raw JSON array (no markdown, no backticks) of exactly 15 objects:
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

Generate 15 post ideas inspired by what's working.`;

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
