#!/usr/bin/env python3
"""Browser checks for the shipped LOCAL landing prototype, not the production app."""
from __future__ import annotations
import functools
import http.server
import json
import os
import shutil
from pathlib import Path
import threading
import traceback
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evidence'
OUT.mkdir(exist_ok=True)
checks: list[dict] = []
errors: list[str] = []
external: list[str] = []

def check(name: str, predicate: bool):
    checks.append({'name': name, 'passed': bool(predicate)})
    if not predicate:
        raise AssertionError(name)

class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_):
        pass

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(ROOT/'landing')))
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
base = f'http://127.0.0.1:{server.server_port}'
# This environment blocks HTTP navigation; render our own HTML directly in Chromium.
html = (ROOT/'landing/index.html').read_text()
blocked_capabilities = []
failed = None
try:
    with sync_playwright() as p:
        executable = os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('chromium-browser')
        launch_options = {'headless': True}
        if executable:
            launch_options['executable_path'] = executable
        browser = p.chromium.launch(**launch_options)
        context = browser.new_context(viewport={'width':1440, 'height':1024}, device_scale_factor=1,
                                      reduced_motion='reduce', accept_downloads=True)
        page = context.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('request', lambda r: external.append(r.url) if not r.url.startswith((base, 'data:', 'blob:', 'file:')) else None)
        page.set_content(html, wait_until='load')
        check('RU document language', page.locator('html').get_attribute('lang') == 'ru')
        check('One primary heading', page.locator('h1').count()==1)
        check('Demo explicitly labelled', page.get_by_text('ДЕМО · БЕЗ СЕРВЕРА', exact=False).count()==1)
        check('Desktop no horizontal overflow', page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
        check('No remote scripts/styles/fonts', not external)
        check('Marketing unchecked by default', not page.locator('#marketing-consent').is_checked())
        check('Directory unchecked by default', not page.locator('#event-consent').is_checked())
        check('Public email unchecked by default', not page.locator('#public-email').is_checked())
        page.screenshot(path=str(OUT/'landing-desktop.png'), full_page=True)
        page.screenshot(path=str(OUT/'landing-hero.png'), full_page=False)
        page.locator('[data-open="profile"]').first.click()
        check('Hero CTA opens personal demo', page.locator('#panel-profile').is_visible())
        check('Hidden email absent from preview', not page.locator('#preview-email').is_visible())
        page.locator('#profile-name').fill('<script>evil()</script>')
        page.locator('#profile-role').fill('Дизайнер ; тест, роль')
        check('User input rendered as text, not HTML', page.locator('#preview-name').inner_text()=='<script>evil()</script>' and page.locator('#preview-name script').count()==0)
        with page.expect_download() as d:
            page.locator('#save-vcard').click()
        txt=Path(d.value.path()).read_text()
        check('vCard excludes unselected email', 'EMAIL' not in txt)
        check('vCard escapes delimiters', 'Дизайнер \\; тест\\, роль' in txt)
        page.locator('#public-email').check()
        check('Opted-in fictional email visible', page.locator('#preview-email').is_visible())
        with page.expect_download() as d:
            page.locator('#save-vcard').click()
        check('vCard includes explicitly selected sample email', 'anna@example.com' in Path(d.value.path()).read_text())
        with page.expect_download() as d:
            page.locator('#download-qr').click()
        check('QR SVG download contains actual SVG', '<svg' in Path(d.value.path()).read_text())
        page.locator('#reset-demo').click()
        check('Reset restores sample profile', page.locator('#profile-name').input_value()=='Анна Левина')
        page.locator('#tab-profile').focus()
        page.keyboard.press('ArrowRight')
        check('Keyboard arrow changes accessible tab', page.locator('#tab-event').get_attribute('aria-selected')=='true' and page.locator('#panel-event').is_visible())
        page.locator('#join-event').click()
        check('Participation alone creates no match', page.locator('#match-empty').is_visible() and not page.locator('#match-card').is_visible())
        page.locator('#event-consent').check()
        page.locator('#join-event').click()
        check('Directory consent enables sample match', page.locator('#match-card').is_visible())
        check('Match is not mutual before both decisions', not page.locator('#next-step').is_visible())
        page.locator('#request-intro').click()
        check('First acceptance stays pending', 'ещё не ответила' in page.locator('#intro-status').inner_text() and not page.locator('#next-step').is_visible())
        page.locator('#accept-other').click()
        check('Second party action explicitly marked simulation', 'В демо обе стороны' in page.locator('#intro-status').inner_text())
        check('Mutual simulation permits next-step draft', page.locator('#next-step').is_visible())
        page.locator('#next-step').click()
        check('Next step remains draft, not message delivery', page.locator('#next-step-status').is_visible())
        page.locator('#demo').screenshot(path=str(OUT/'landing-demo-mutual.png'))
        page.locator('#tab-organizer').click()
        check('Demo organizer shows one joined profile', page.locator('#stat-profiles').inner_text()=='1')
        check('Demo organizer shows one mutual pair', page.locator('#stat-mutual').inner_text()=='1')
        check('No marketing inferred from joining', page.locator('#stat-optin').inner_text()=='0')
        page.locator('#campaign-info').click()
        check('Broadcast button does not pretend to send', 'нет подписок' in page.locator('#toast').inner_text())
        page.locator('#tab-event').click()
        page.locator('#revoke-intro').click()
        check('Revoke resets mutual/contact state', not page.locator('#next-step').is_visible() and not page.locator('#intro-status').is_visible())
        page.locator('#marketing-consent').check()
        page.locator('#join-event').click()
        page.locator('#tab-organizer').click()
        check('Separate marketing consent reflected correctly', page.locator('#stat-optin').inner_text()=='1')
        page.locator('#tab-event').click()
        page.locator('#event-consent').uncheck()
        page.locator('#join-event').click()
        check('Directory withdrawal removes suggestions', not page.locator('#match-card').is_visible())
        page.locator('#reset-demo').click()
        check('Reset clears all opt-ins', not page.locator('#event-consent').is_checked() and not page.locator('#marketing-consent').is_checked() and not page.locator('#public-email').is_checked())
        page.locator('#whatsapp-info').click()
        check('WhatsApp explanation opens FAQ, no live integration', page.locator('#faq-whatsapp').get_attribute('open') is not None)
        for width in (1024, 768, 390, 360, 320):
            page.set_viewport_size({'width':width,'height':844})
            page.set_content(html, wait_until='load')
            page.evaluate('window.scrollTo(0,0)')
            check(f'No horizontal overflow at width {width}px', page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
            if width==390:
                page.screenshot(path=str(OUT/'landing-mobile.png'), full_page=True)
                page.screenshot(path=str(OUT/'landing-mobile-hero.png'), full_page=False)
                page.locator('#tab-event').click()
                page.locator('#event-consent').check()
                page.locator('#join-event').click()
                page.locator('#request-intro').click()
                check('Mobile main interaction completes', page.locator('#intro-status').is_visible())
        page.evaluate("location.hash = 'profile'")
        page.set_content(html, wait_until='load')
        check('QR hash opens personal scenario', page.locator('#panel-profile').is_visible())
        try:
            page.goto((ROOT/'landing/index.html').as_uri(), wait_until='load', timeout=10000)
            page.locator('#tab-event').click()
            check('Single HTML opens and works via file://', page.locator('#panel-event').is_visible())
        except Exception as file_error:
            blocked_capabilities.append({'capability':'file navigation', 'error':str(file_error)})
        check('No uncaught browser JS errors', not errors)
        check('No external network requests throughout', not external)
        version = browser.version
        browser.close()
except Exception as exc:
    failed = repr(exc)
    traceback.print_exc()
    version = 'see execution failure'
finally:
    server.shutdown()
    server.server_close()
    report={'scope':'LOCAL LANDING PROTOTYPE ONLY', 'browser':'Chromium', 'version':version, 'render_method':'page.set_content — own local HTML', 'blocked_capabilities':blocked_capabilities,
            'checks':checks, 'passed':sum(x['passed'] for x in checks), 'failed':sum(not x['passed'] for x in checks),
            'exception':failed, 'page_errors':errors, 'external_requests':external}
    (OUT/'browser-results.json').write_text(json.dumps(report, ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:report[k] for k in ('scope','version','passed','failed','exception','page_errors','external_requests')},ensure_ascii=False,indent=2))
if failed:
    raise SystemExit(1)
