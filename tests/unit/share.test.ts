import test from 'node:test';
import assert from 'node:assert/strict';
import { SHARE_NETWORKS, shareHref, type ShareNetwork } from '../../src/domain/share';

/** Share deeplinks (interop §A3 "Share-deeplinks"): links only, nothing else. */

const CARD_URL = 'https://welcome.example/p/alice-nova';
const CARD_WITH_QUERY = 'https://welcome.example/p/alice?ref=chat&x=1';

test('share: four networks, in display order', () => {
  assert.deepEqual([...SHARE_NETWORKS], ['linkedin', 'whatsapp', 'telegram', 'x']);
});

test('share: every network produces an https deeplink on its own domain', () => {
  const hosts: Record<ShareNetwork, string> = {
    linkedin: 'www.linkedin.com',
    whatsapp: 'wa.me',
    telegram: 't.me',
    x: 'x.com',
  };
  for (const network of SHARE_NETWORKS) {
    const href = shareHref(network, CARD_URL, 'Alice Nova');
    assert.ok(href, `${network} must produce a link`);
    const parsed = new URL(href);
    assert.equal(parsed.protocol, 'https:');
    assert.equal(parsed.host, hosts[network]);
    assert.ok(parsed.search.length > 0, `${network} must carry parameters`);
  }
});

test('share: the target URL round-trips through the query string', () => {
  const linkedin = new URL(shareHref('linkedin', CARD_WITH_QUERY)!);
  assert.equal(linkedin.searchParams.get('url'), CARD_WITH_QUERY);

  const telegram = new URL(shareHref('telegram', CARD_URL, 'Alice Nova')!);
  assert.equal(telegram.searchParams.get('url'), CARD_URL);
  assert.equal(telegram.searchParams.get('text'), 'Alice Nova');

  const whatsapp = new URL(shareHref('whatsapp', CARD_URL, 'Alice Nova')!);
  // WhatsApp has a single text field: the message carries the link.
  assert.equal(whatsapp.searchParams.get('text'), `Alice Nova ${CARD_URL}`);

  const x = new URL(shareHref('x', CARD_URL, 'Alice Nova')!);
  assert.equal(x.searchParams.get('url'), CARD_URL);
  assert.equal(x.searchParams.get('text'), 'Alice Nova');
});

test('share: a blank title degrades to a link-only deeplink', () => {
  assert.equal(new URL(shareHref('telegram', CARD_URL, '   ')!).searchParams.has('text'), false);
  assert.equal(new URL(shareHref('x', CARD_URL, '')!).searchParams.has('text'), false);
  assert.equal(new URL(shareHref('whatsapp', CARD_URL, '')!).searchParams.get('text'), CARD_URL);
});

test('share: a non-http(s) or relative value yields no link at all', () => {
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', '/p/alice', 'not a url', 'mailto:a@b.c', '']) {
    for (const network of SHARE_NETWORKS) {
      assert.equal(shareHref(network, bad), null, `${network} must refuse ${bad}`);
    }
  }
});
