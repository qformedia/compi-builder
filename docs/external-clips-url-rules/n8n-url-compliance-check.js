const items = $input.all();

for (const item of items) {
  const originalUrl = (item.json.linkUrl || '').trim();

  if (!originalUrl) {
    item.json.status = 'invalid';
    item.json.fixedUrl = '';
    item.json.network = 'empty';
    item.json.issues = ['empty URL'];
    continue;
  }

  let url = originalUrl;
  let network = 'other';
  let issues = [];
  const lower = url.toLowerCase();

  if (lower.includes('instagram.com')) network = 'instagram';
  else if (lower.includes('tiktok.com')) network = 'tiktok';
  else if (lower.includes('youtube.com') || lower.includes('youtu.be')) network = 'youtube';
  else if (lower.includes('pinterest.')) network = 'pinterest';
  else if (lower.includes('bilibili.com')) network = 'bilibili';
  else if (lower.includes('douyin.com')) network = 'douyin';
  else if (lower.includes('kuaishou.com')) network = 'kuaishou';
  else if (lower.includes('xiaohongshu.com')) network = 'xiaohongshu';

  if (['kuaishou', 'xiaohongshu', 'other'].includes(network)) {
    item.json.status = 'ok';
    item.json.fixedUrl = url;
    item.json.network = network;
    item.json.issues = [];
    continue;
  }

  // General: fix www.ww. / www.www. typo on any domain
  if (/www\.ww\./.test(url)) {
    url = url.replace(/www\.ww\./, 'www.');
    issues.push('fixed www.ww. typo');
  }
  if (/www\.www\./.test(url)) {
    url = url.replace(/www\.www\./, 'www.');
    issues.push('fixed www.www. typo');
  }

  let isValid = false;

  // --- INSTAGRAM ---
  if (network === 'instagram') {
    if (url.includes('?')) { url = url.split('?')[0]; issues.push('stripped query params'); }
    if (url.includes('#')) { url = url.split('#')[0]; }

    if (/\/reels\/[A-Za-z0-9_-]+/.test(url)) {
      const m = url.match(/\/reels\/([A-Za-z0-9_-]+)\/?$/);
      if (m) { url = url.replace(/\/reels\/([A-Za-z0-9_-]+)\/?$/, '/reel/$1/'); issues.push('/reels/ → /reel/'); }
    }
    if (/\/p\/[A-Za-z0-9_-]+/.test(url)) {
      url = url.replace(/\/p\/([A-Za-z0-9_-]+)\/?$/, '/reel/$1/');
      issues.push('/p/ → /reel/');
    }

    const afterDomain = url.replace(/https?:\/\/www\.instagram\.com\//, '');
    const parts = afterDomain.replace(/^\/|\/$/g, '').split('/');
    if (parts.length >= 3 && !['reel', 'tv', 'p', 'reels', 'stories'].includes(parts[0])) {
      if (['reel', 'tv'].includes(parts[1]) && parts[2]) {
        url = `https://www.instagram.com/${parts[1]}/${parts[2]}/`;
        issues.push('stripped username prefix');
      }
    }

    if (/^https:\/\/www\.instagram\.com\/(reel|tv)\/[A-Za-z0-9_-]+$/.test(url)) {
      url += '/'; issues.push('added trailing /');
    }

    isValid = /^https:\/\/www\.instagram\.com\/(reel|tv)\/[A-Za-z0-9_-]+\/$/.test(url);
    if (!isValid && issues.length === 0) issues.push('non-standard URL — manual review');
  }

  // --- TIKTOK ---
  if (network === 'tiktok') {
    if ((url.match(/http/g) || []).length > 1) {
      item.json.status = 'invalid'; item.json.fixedUrl = url; item.json.network = network;
      item.json.issues = ['two URLs in same field — manual review'];
      continue;
    }
    if (!url.startsWith('http')) { url = 'https://www.' + url.replace(/^\/+/, ''); issues.push('added https://www.'); }
    if (url.includes('?')) { url = url.split('?')[0]; issues.push('stripped query params'); }
    if (url.includes('#')) { url = url.split('#')[0]; }

    const trailingMatch = url.match(/^(https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+)\/$/);
    if (trailingMatch) { url = trailingMatch[1]; issues.push('removed trailing /'); }

    if (url.includes('/photo/')) {
      item.json.status = 'invalid'; item.json.fixedUrl = url; item.json.network = network;
      item.json.issues = ['photo post — manual review'];
      continue;
    }
    if (!url.includes('/video/')) {
      item.json.status = 'invalid'; item.json.fixedUrl = url; item.json.network = network;
      item.json.issues = ['creator profile URL — manual review'];
      continue;
    }

    isValid = /^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d{15,19}$/.test(url);
    if (!isValid && issues.length === 0) issues.push('non-standard URL — manual review');
  }

  // --- YOUTUBE ---
  if (network === 'youtube') {
    if (/^https?:\/\/www\.youtu\.be\//.test(url)) {
      url = url.replace(/^https?:\/\/www\.youtu\.be\//, 'https://youtu.be/');
      issues.push('stripped www. from youtu.be');
    }
    if (url.includes('youtu.be/') && url.includes('?')) { url = url.split('?')[0]; issues.push('stripped query params'); }

    const watchMatch = url.match(/^https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/);
    if (watchMatch) { url = `https://youtu.be/${watchMatch[1]}`; issues.push('watch?v= → youtu.be/'); }

    if (url.includes('youtube.com/shorts/') && url.includes('?')) {
      url = url.split('?')[0]; issues.push('stripped query params from shorts');
    }
    if (/^https:\/\/youtu\.be\/[A-Za-z0-9_-]{11}\/$/.test(url)) { url = url.replace(/\/$/, ''); issues.push('removed trailing /'); }
    if (/^https:\/\/www\.youtube\.com\/shorts\/[A-Za-z0-9_-]{11}\/$/.test(url)) { url = url.replace(/\/$/, ''); issues.push('removed trailing /'); }

    if (/youtube\.com\/(@|c\/|channel\/)/.test(url)) {
      item.json.status = 'invalid'; item.json.fixedUrl = url; item.json.network = network;
      item.json.issues = ['channel/user page — manual review'];
      continue;
    }

    isValid = /^https:\/\/www\.youtube\.com\/shorts\/[A-Za-z0-9_-]{11}$/.test(url)
           || /^https:\/\/youtu\.be\/[A-Za-z0-9_-]{11}$/.test(url);
    if (!isValid && issues.length === 0) issues.push('non-standard URL — manual review');
  }

  // --- PINTEREST ---
  if (network === 'pinterest') {
    if (url.includes('?')) { url = url.split('?')[0]; issues.push('stripped query params'); }

    const pinDomain = url.match(/^(https?:\/\/)([^/]*pinterest[^/]*)(\/.*)/);
    if (pinDomain && pinDomain[2] !== 'www.pinterest.es') {
      url = `https://www.pinterest.es${pinDomain[3]}`;
      issues.push('normalized domain → www.pinterest.es');
    }
    if (/^https:\/\/www\.pinterest\.es\/pin\/[^/]+$/.test(url)) { url += '/'; issues.push('added trailing /'); }

    isValid = /^https:\/\/www\.pinterest\.es\/pin\/[A-Za-z0-9_-]+\/$/.test(url);
    if (!isValid && issues.length === 0) issues.push('non-standard URL — manual review');
  }

  // --- BILIBILI ---
  if (network === 'bilibili') {
    if (url.includes('?')) { url = url.split('?')[0]; issues.push('stripped query params'); }
    if (/^https:\/\/www\.bilibili\.com\/video\/BV[A-Za-z0-9]+$/.test(url)) { url += '/'; issues.push('added trailing /'); }

    isValid = /^https:\/\/www\.bilibili\.com\/video\/BV[A-Za-z0-9]+\/$/.test(url);
    if (!isValid && issues.length === 0) issues.push('non-standard URL — manual review');
  }

  // --- DOUYIN ---
  if (network === 'douyin') {
    const iesMatch = url.match(/^https?:\/\/(?:www\.)?iesdouyin\.com\/share\/video\/(\d+)\/?/);
    if (iesMatch) { url = `https://www.douyin.com/video/${iesMatch[1]}`; issues.push('iesdouyin → douyin.com/video/'); }

    const modalMatch = url.match(/^https?:\/\/(?:www\.)?douyin\.com\/user\/[^?]+\?modal_id=(\d+)/);
    if (modalMatch) { url = `https://www.douyin.com/video/${modalMatch[1]}`; issues.push('extracted modal_id → douyin.com/video/'); }

    if (url.includes('v.douyin.com')) {
      item.json.status = 'invalid'; item.json.fixedUrl = url; item.json.network = network;
      item.json.issues = ['v.douyin.com short link — requires redirect resolution; manual review'];
      continue;
    }
    if (url.includes('?')) { url = url.split('?')[0]; issues.push('stripped query params'); }

    const dyTrailing = url.match(/^(https:\/\/www\.douyin\.com\/video\/\d+)\/$/);
    if (dyTrailing) { url = dyTrailing[1]; issues.push('removed trailing /'); }

    if (/^https?:\/\/(?:www\.)?douyin\.com\/user\//.test(url)) {
      item.json.status = 'invalid'; item.json.fixedUrl = url; item.json.network = network;
      item.json.issues = ['creator profile — manual review'];
      continue;
    }

    isValid = /^https:\/\/www\.douyin\.com\/video\/\d{15,}$/.test(url);
    if (!isValid && issues.length === 0) issues.push('non-standard URL — manual review');
  }

  // Three clear outcomes
  if (isValid && url === originalUrl) {
    item.json.status = 'ok';
  } else if (isValid && url !== originalUrl) {
    item.json.status = 'fixed';
  } else {
    item.json.status = 'invalid';
  }

  item.json.fixedUrl = url;
  item.json.network = network;
  item.json.issues = issues;
}

return items;
