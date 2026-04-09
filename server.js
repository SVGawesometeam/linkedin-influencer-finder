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
async function runApifyActor(actorId, input) {
  const token = process.env.APIFY_API_TOKEN;
  if (!token) throw new Error('APIFY_API_TOKEN not configured');

  const startRes = await fetch(
    `https://api.apify.com/v2/acts/${actorId}/runs?token=${token}`,
    {
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
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  if (ageMs > sevenDays) return null;

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
// API: Find influencers
// =============================================
app.post('/api/influencers', async (req, res) => {
  const { niche } = req.body;
  if (!niche) return res.status(400).json({ error: 'Niche is required' });

  try {
    // Check cache
    const cached = await getCachedNiche(niche);
    if (cached) {
      console.log(`Cache hit: ${niche}`);
      return res.json({
        profiles: JSON.parse(cached.profiles),
        posts: JSON.parse(cached.posts),
        fromCache: true,
      });
    }

    console.log(`Cache miss: ${niche}. Scraping...`);

    // Step 1: Search profiles
    const searchInput = {
      searchUrl: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(niche)}&origin=GLOBAL_SEARCH_HEADER`,
      maxProfiles: 50,
    };
    console.log('Apify search input:', JSON.stringify(searchInput));

    const searchResults = await runApifyActor('harvestapi~linkedin-profile-search', searchInput);
    console.log(`Apify returned ${searchResults ? searchResults.length : 0} profiles`);

    if (!searchResults || searchResults.length === 0) {
      throw new Error('No profiles found. Try different keywords.');
    }

    // Log first result structure for debugging
    if (searchResults[0]) {
      console.log('Sample profile keys:', Object.keys(searchResults[0]).join(', '));
    }

    const sorted = searchResults
      .filter(p => (p.fullName || p.name || p.firstName) && (p.profileUrl || p.url || p.linkedinUrl))
      .map(p => ({
        name: p.fullName || p.name || [p.firstName, p.lastName].filter(Boolean).join(' ') || '',
        title: p.headline || p.title || p.occupation || '',
        profileUrl: p.profileUrl || p.url || p.linkedinUrl || '',
        followers: parseInt(p.followersCount || p.followers || p.followerCount || 0),
        location: p.location || p.geo || '',
      }))
      .sort((a, b) => b.followers - a.followers)
      .slice(0, 20);

    // Step 2: Scrape posts from top 10
    const profileUrls = sorted.slice(0, 10).map(p => p.profileUrl).filter(Boolean);

    let allPosts = [];
    if (profileUrls.length > 0) {
      const postResults = await runApifyActor('harvestapi~linkedin-profile-posts', {
        profileUrls,
        maxPosts: 10,
      });

      if (postResults && postResults.length > 0) {
        allPosts = postResults
          .filter(p => p.text || p.postText || p.content)
          .map(p => ({
            authorName: p.authorName || p.author?.name || '',
            authorUrl: p.authorProfileUrl || p.author?.url || '',
            text: (p.text || p.postText || p.content || '').slice(0, 500),
            likes: parseInt(p.likesCount || p.reactions || p.numLikes || 0),
            comments: parseInt(p.commentsCount || p.numComments || 0),
            reposts: parseInt(p.repostsCount || p.numReposts || 0),
            postUrl: p.postUrl || p.url || '',
            postedAt: p.postedAt || p.publishedAt || '',
          }))
          .map(p => ({ ...p, engagement: p.likes + p.comments * 3 + p.reposts * 2 }))
          .sort((a, b) => b.engagement - a.engagement)
          .slice(0, 50);
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
