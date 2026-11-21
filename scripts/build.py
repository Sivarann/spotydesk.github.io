#!/usr/bin/env python3
"""Build all original Peekabu411 Turntable files with an additive Canvas overlay.

Usage: python scripts/build.py /path/to/original-turntable /path/to/output
ENV CANVAS_API_URL is an optional public HTTPS Canvas API endpoint, never a secret.
"""
import html
import json
import os
from pathlib import Path
import re
import shutil
import sys
from urllib.parse import urlparse

BASE = Path(__file__).resolve().parents[1]
OVERLAY = BASE / 'overlay'
USER_ADDRESS = 'https://sivarann.github.io/spotydesk.github.io/'
UPSTREAM_ADDRESS = 'https://peekabu411.github.io/'


def replace_once(s, pattern, replacement, file, flags=0):
    changed, n = re.subn(pattern, replacement, s, count=1, flags=flags)
    if n != 1:
        raise RuntimeError(f'{file}: cannot find required upstream insertion point. Refusing to publish a partial/broken site.')
    return changed


def acceptable_api_url(raw):
    raw = raw.strip()
    if not raw:
        return ''
    u = urlparse(raw)
    if (u.scheme != 'https' or not u.netloc or u.username or u.password or
        u.query or u.fragment or not (u.path == '/api/canvas' or u.path == '/api/canvas/')):
        raise ValueError('CANVAS_API_URL must be a public HTTPS URL ending in /api/canvas (no cookie, token or query string).')
    return raw.rstrip('/')


def extend_csp(content, api_origin):
    # Original Turntable may have an explicit CSP. Only add the host needed for API + CDN video.
    csp_meta = re.compile(r'<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["\']Content-Security-Policy["\'])[^>]*>', re.I | re.S)
    found = csp_meta.search(content)
    if not found:
        return content
    tag = found.group(0)
    match = re.search(r'\bcontent\s*=\s*(["\'])(.*?)\1', tag, flags=re.I | re.S)
    if not match:
        return content
    directives = html.unescape(match.group(2)).split(';')
    need = ['https://canvaz.scdn.co']
    connected = [api_origin] if api_origin else []
    keys = {'media-src': need, 'connect-src': connected}
    existing = set()
    for i, raw in enumerate(directives):
        words = raw.strip().split()
        if not words:
            continue
        key = words[0].lower()
        if key not in keys:
            continue
        existing.add(key)
        for origin in keys[key]:
            if origin not in words:
                words.append(origin)
        directives[i] = ' '.join(words)
    for key, origins in keys.items():
        if key not in existing and origins:
            # If a directive is missing, default-src or none may restrict it.
            directives.append(' '.join([key, "'self'", *origins]))
    updated = '; '.join(d.strip() for d in directives if d.strip())
    new_tag = tag[:match.start(2)] + html.escape(updated, quote=True) + tag[match.end(2):]
    return content[:found.start()] + new_tag + content[found.end():]


def build(src: Path, dst: Path):
    if src.resolve() == dst.resolve():
        raise RuntimeError('Output must differ from upstream checkout')
    if not (src / 'index.html').is_file() or not (src / 'app.js').is_file() or not (src / 'bridge.js').is_file():
        raise RuntimeError('Upstream is missing index.html, app.js or bridge.js — this is not the expected full Turntable repository')
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=shutil.ignore_patterns('.git', 'node_modules', '__pycache__', '*.pyc'))

    cfg = json.loads((OVERLAY / 'canvas-config.json').read_text(encoding='utf-8'))
    # GitHub Actions exports missing repository variables as empty strings.
    # Empty override must not erase the valid checked-in endpoint.
    configured_url = (os.environ.get('CANVAS_API_URL') or '').strip() or cfg.get('endpoint', '') or ''
    cfg['endpoint'] = acceptable_api_url(configured_url)
    api_origin = ''
    if cfg['endpoint']:
        u = urlparse(cfg['endpoint'])
        api_origin = f'{u.scheme}://{u.netloc}'
    (dst / 'canvas-config.json').write_text(json.dumps(cfg, indent=2) + '\n', encoding='utf-8')

    for filename in ('canvas-background.js', 'canvas-background.css', 'video-loops.json'):
        shutil.copy2(OVERLAY / filename, dst / filename)

    # Embed the public Canvas endpoint directly in the script. A cached or missing
    # JSON config must not disable Canvas on Android PWA installations.
    canvas_js = dst / 'canvas-background.js'
    canvas_source = canvas_js.read_text(encoding='utf-8')
    canvas_source = replace_once(
        canvas_source,
        r'(?m)^  const DEFAULT_CANVAS_ENDPOINT = .*?;$',
        '  const DEFAULT_CANVAS_ENDPOINT = ' + json.dumps(cfg['endpoint']) + ';',
        'canvas-background.js')
    canvas_js.write_text(canvas_source, encoding='utf-8')
    if (OVERLAY / 'videos').is_dir():
        shutil.copytree(OVERLAY / 'videos', dst / 'videos', dirs_exist_ok=True)

    index = dst / 'index.html'
    html_text = index.read_text(encoding='utf-8')
    if 'canvas-background.css' not in html_text:
        html_text = replace_once(html_text, r'</head>', '<link rel="stylesheet" href="./canvas-background.css?v=7">\n</head>', 'index.html', flags=re.I)
    # Redirect instructions and hardcoded redirect URLs must point at this fork's domain.
    html_text = html_text.replace(UPSTREAM_ADDRESS, USER_ADDRESS)
    html_text = extend_csp(html_text, api_origin)
    # The upstream bridge URL never changed between Canvas releases.
    # Version it here to avoid old Android scripts despite the updated PWA.
    html_text = replace_once(
        html_text,
        r'(<script\s+src="\./bridge\.js)(?:\?[^"]*)?("\s*></script>)',
        lambda m: m.group(1) + '?v=spotydesk-fast-sync-v7' + m.group(2),
        'index.html')
    index.write_text(html_text, encoding='utf-8')

    # Both upstream manifests must stay scoped to this GitHub Pages project URL.
    # index.html uses manifest.json, which includes a UTF-8 BOM upstream.
    for manifest_name in ('manifest.webmanifest', 'manifest.json'):
        manifest = dst / manifest_name
        if not manifest.exists():
            continue
        try:
            manifest_data = json.loads(manifest.read_text(encoding='utf-8-sig'))
        except json.JSONDecodeError as exc:
            raise RuntimeError(f'Turntable {manifest_name} is not valid JSON') from exc
        if not isinstance(manifest_data, dict):
            raise RuntimeError(f'Turntable {manifest_name} must contain a JSON object')
        manifest_data['start_url'] = './'
        manifest_data['scope'] = './'
        manifest_data['name'] = 'SpotyDesk Turntable'
        manifest_data['short_name'] = 'SpotyDesk'
        manifest.write_text(json.dumps(manifest_data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    bridge = dst / 'bridge.js'
    js = bridge.read_text(encoding='utf-8')
    if 'canvas-background.js' not in js:
        js = replace_once(js,
            r'await\s+load\(\s*["\']\./app\.js(?:\?[^"\']*)?["\']\s*\)\s*;',
            lambda m: 'await load("./canvas-background.js?v=7");\n' + m.group(0),
            'bridge.js')
    js = replace_once(js,
        r'await\s+load\(\s*["\x27]\./app\.js(?:\?[^"\x27]*)?["\x27]\s*\)\s*;',
        'await load("./app.js?v=spotydesk-fast-sync-v7");', 'bridge.js')
    bridge.write_text(js, encoding='utf-8')

    app = dst / 'app.js'
    js = app.read_text(encoding='utf-8')
    if 'turntableCanvasBackground?.syncTrack(' not in js:
        js = replace_once(js,
            r'(?m)^(?P<indent>[ \t]*)remote\.classList\.toggle\(\s*["\']is-playing["\']\s*,\s*!!playback\?\.is_playing\s*\);',
            lambda m: m.group(0) + '\n' + m.group('indent') + 'window.turntableCanvasBackground?.syncTrack(track, !!playback?.is_playing);',
            'app.js')
    # Faster foreground polling for songs skipped on another Spotify device.
    # The upstream Spotify 429 cooldown logic remains intact.
    js = replace_once(js, r"(?m)^const ACTIVE_STATUS_REFRESH_MS = 7_500;$",
                      "const ACTIVE_STATUS_REFRESH_MS = 3_000;", "app.js")
    js = replace_once(js, r"(?m)^const IDLE_STATUS_REFRESH_MS = 15_000;$",
                      "const IDLE_STATUS_REFRESH_MS = 6_000;", "app.js")
    js = js.replace(UPSTREAM_ADDRESS, USER_ADDRESS)
    app.write_text(js, encoding='utf-8')

    sw = dst / 'sw.js'
    if sw.exists():
        text = sw.read_text(encoding='utf-8')
        text = text.replace('./bridge.js?v=I.9.8-viewport-resume', './bridge.js?v=spotydesk-fast-sync-v7')
        text = replace_once(text, r'\./app\.js(?:\?[^"\x27]*)?', './app.js?v=spotydesk-fast-sync-v7', 'sw.js')
        if 'canvas-background.js' not in text:
            text = replace_once(text,
                r'(["\']\./manifest\.webmanifest["\'])',
                lambda m: m.group(1) + ',\n  "./canvas-background.js", "./canvas-background.css", "./canvas-config.json", "./video-loops.json"',
                'sw.js')
        text = re.sub(r'(?m)(\bconst\s+CACHE\s*=\s*)(["\'])(.*?)(["\'])\s*;',
                      lambda m: f'{m.group(1)}{m.group(2)}{m.group(3)}-spotydesk-fast-sync-v7{m.group(2)};',
                      text, count=1)
        sw.write_text(text, encoding='utf-8')

    # Built Pages deployments do not need Jekyll processing.
    (dst / '.nojekyll').touch()
    # No special branding replacement: all upstream artwork, lyrics, playlists,
    # originals, licensing, attribution and styling stay in place.
    print(f'OK: original repository copied to {dst} with Canvas background integration')
    print('Canvas API:', cfg['endpoint'] or '(not configured; original artwork used)')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('Usage: python scripts/build.py path/to/original-turntable path/to/site-output')
    try:
        build(Path(sys.argv[1]), Path(sys.argv[2]))
    except Exception as e:
        sys.exit(f'BUILD FAILED: {e}')
,
                      'const ACTIVE_STATUS_REFRESH_MS = 3_000;', 'app.js')
    js = replace_once(js, r'(?m)^const IDLE_STATUS_REFRESH_MS = 15_000;
    js = js.replace(UPSTREAM_ADDRESS, USER_ADDRESS)
    app.write_text(js, encoding='utf-8')

    sw = dst / 'sw.js'
    if sw.exists():
        text = sw.read_text(encoding='utf-8')
        text = text.replace('./bridge.js?v=I.9.8-viewport-resume', './bridge.js?v=spotydesk-fast-sync-v7')
        if 'canvas-background.js' not in text:
            text = replace_once(text,
                r'(["\']\./manifest\.webmanifest["\'])',
                lambda m: m.group(1) + ',\n  "./canvas-background.js", "./canvas-background.css", "./canvas-config.json", "./video-loops.json"',
                'sw.js')
        text = re.sub(r'(?m)(\bconst\s+CACHE\s*=\s*)(["\'])(.*?)(["\'])\s*;',
                      lambda m: f'{m.group(1)}{m.group(2)}{m.group(3)}-spotydesk-fast-sync-v7{m.group(2)};',
                      text, count=1)
        sw.write_text(text, encoding='utf-8')

    # Built Pages deployments do not need Jekyll processing.
    (dst / '.nojekyll').touch()
    # No special branding replacement: all upstream artwork, lyrics, playlists,
    # originals, licensing, attribution and styling stay in place.
    print(f'OK: original repository copied to {dst} with Canvas background integration')
    print('Canvas API:', cfg['endpoint'] or '(not configured; original artwork used)')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('Usage: python scripts/build.py path/to/original-turntable path/to/site-output')
    try:
        build(Path(sys.argv[1]), Path(sys.argv[2]))
    except Exception as e:
        sys.exit(f'BUILD FAILED: {e}')
,
                      'const IDLE_STATUS_REFRESH_MS = 6_000;', 'app.js')
    # Replace hardcoded redirect strings if any, not original GitHub project credits.
    js = js.replace(UPSTREAM_ADDRESS, USER_ADDRESS)
    app.write_text(js, encoding='utf-8')

    sw = dst / 'sw.js'
    if sw.exists():
        text = sw.read_text(encoding='utf-8')
        text = text.replace('./bridge.js?v=I.9.8-viewport-resume', './bridge.js?v=spotydesk-fast-sync-v7')
        if 'canvas-background.js' not in text:
            text = replace_once(text,
                r'(["\']\./manifest\.webmanifest["\'])',
                lambda m: m.group(1) + ',\n  "./canvas-background.js", "./canvas-background.css", "./canvas-config.json", "./video-loops.json"',
                'sw.js')
        text = re.sub(r'(?m)(\bconst\s+CACHE\s*=\s*)(["\'])(.*?)(["\'])\s*;',
                      lambda m: f'{m.group(1)}{m.group(2)}{m.group(3)}-spotydesk-fast-sync-v7{m.group(2)};',
                      text, count=1)
        sw.write_text(text, encoding='utf-8')

    # Built Pages deployments do not need Jekyll processing.
    (dst / '.nojekyll').touch()
    # No special branding replacement: all upstream artwork, lyrics, playlists,
    # originals, licensing, attribution and styling stay in place.
    print(f'OK: original repository copied to {dst} with Canvas background integration')
    print('Canvas API:', cfg['endpoint'] or '(not configured; original artwork used)')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('Usage: python scripts/build.py path/to/original-turntable path/to/site-output')
    try:
        build(Path(sys.argv[1]), Path(sys.argv[2]))
    except Exception as e:
        sys.exit(f'BUILD FAILED: {e}')
