// One-time setup: exchange a short-lived Graph API Explorer token for a
// never-expiring Page token, then write FACEBOOK_PAGE_ID +
// FACEBOOK_PAGE_ACCESS_TOKEN into .env.local.
//
// Usage:
//   npx tsx scripts/facebook-token-setup.ts <appId> <appSecret> <shortLivedUserToken>
//
// Safe to re-run. Does not commit anything; .env.local is gitignored.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

const GRAPH = 'https://graph.facebook.com/v23.0';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new Error(json.error?.message || `HTTP ${res.status} from ${url.split('?')[0]}`);
  }
  return json;
}

function upsertEnv(envPath: string, vars: Record<string, string>) {
  let text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  for (const [key, value] of Object.entries(vars)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^#?\\s*${key}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : text.replace(/\n?$/, `\n${line}\n`);
  }
  writeFileSync(envPath, text);
}

async function main() {
  const [appId, appSecret, shortToken, pageIdArg] = process.argv.slice(2);
  if (!appId || !appSecret || !shortToken) {
    console.error('Usage: npx tsx scripts/facebook-token-setup.ts <appId> <appSecret> <shortLivedUserToken> [pageId]');
    process.exit(1);
  }

  console.log('1/4 Exchanging for long-lived user token…');
  const longLived = await getJson(
    `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token` +
      `&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${shortToken}`
  );

  console.log('2/4 Fetching Pages you manage…');
  const accounts = await getJson(`${GRAPH}/me/accounts?access_token=${longLived.access_token}`);
  let pages: Array<{ id: string; name: string; access_token: string }> = accounts.data || [];
  if (pageIdArg && !pages.some((p) => p.id === pageIdArg)) {
    // Fallback: query the page directly — works when the user has admin
    // access but the page is missing from me/accounts (business-portfolio quirk).
    console.log(`   Page ${pageIdArg} not in me/accounts — trying direct lookup…`);
    const direct = await getJson(
      `${GRAPH}/${pageIdArg}?fields=id,name,access_token&access_token=${longLived.access_token}`
    ).catch((e) => {
      console.log('   Direct lookup failed:', e.message);
      return {};
    });
    if (direct.access_token) pages = [direct, ...pages];
    else if (direct.id) console.log('   Direct lookup returned no access_token.');
  }
  if (pages.length === 0) {
    // Diagnostics: who is this token for, and what did Facebook actually grant?
    const me = await getJson(
      `${GRAPH}/me?fields=id,name&access_token=${longLived.access_token}`
    ).catch((e) => ({ error: e.message }));
    const perms = await getJson(
      `${GRAPH}/me/permissions?access_token=${longLived.access_token}`
    ).catch((e) => ({ error: e.message }));
    console.log('\n--- DIAGNOSTICS ---');
    console.log('Token user:', JSON.stringify(me));
    console.log('Granted permissions:', JSON.stringify(perms));
    console.log('me/accounts raw:', JSON.stringify(accounts));
    console.log('-------------------\n');
    throw new Error(
      'No Pages returned. Send the DIAGNOSTICS block above to Claude.'
    );
  }
  const page =
    (pageIdArg ? pages.find((p) => p.id === pageIdArg) : undefined) ??
    pages.find((p) => /lakeside/i.test(p.name)) ??
    pages[0];
  if (pages.length > 1) {
    console.log(`   Found ${pages.length} pages: ${pages.map((p) => `${p.name} (${p.id})`).join(', ')}`);
  }
  const info = await getJson(
    `${GRAPH}/${page.id}?fields=name,link,fan_count&access_token=${page.access_token}`
  ).catch(() => ({}));
  console.log(`   Using page: ${page.name} (${page.id})`);
  if (info.link) console.log(`   Link: ${info.link} — followers: ${info.fan_count ?? '?'}`);

  console.log('3/4 Verifying the Page token never expires…');
  const debug = await getJson(
    `${GRAPH}/debug_token?input_token=${page.access_token}&access_token=${appId}|${appSecret}`
  );
  const expiresAt = debug.data?.expires_at;
  console.log(
    expiresAt === 0
      ? '   Expires: Never ✓'
      : `   WARNING: token expires at ${new Date(expiresAt * 1000).toISOString()} — written anyway, but tell Claude.`
  );

  console.log('4/4 Writing .env.local…');
  const envPath = path.join(process.cwd(), '.env.local');
  const vars: Record<string, string> = {
    FACEBOOK_PAGE_ID: page.id,
    FACEBOOK_PAGE_ACCESS_TOKEN: page.access_token,
  };

  // Instagram (optional): if the token has instagram_basic and the Page has a
  // linked professional IG account, record its id too.
  const ig = await getJson(
    `${GRAPH}/${page.id}?fields=instagram_business_account&access_token=${page.access_token}`
  ).catch(() => ({}));
  const igId = ig.instagram_business_account?.id;
  if (igId) {
    const igInfo = await getJson(
      `${GRAPH}/${igId}?fields=username&access_token=${page.access_token}`
    ).catch(() => ({}));
    console.log(`   Instagram: @${igInfo.username ?? '?'} (${igId}) ✓`);
    vars.INSTAGRAM_ACCOUNT_ID = igId;
  } else {
    console.log(
      '   Instagram: not found — either the token lacks instagram_basic or no IG ' +
      'account is linked to the Page. (Fine if you only post to Facebook.)'
    );
  }

  upsertEnv(envPath, vars);

  console.log('\nDone. Restart the dev server (npm run dev) to pick up the new vars.');
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
