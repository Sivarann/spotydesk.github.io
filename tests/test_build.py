import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / 'scripts' / 'build.py'


class BuildTests(unittest.TestCase):
    def create_upstream(self, directory, bad=False):
        source = directory / 'original'
        source.mkdir()
        (source / 'index.html').write_text('''<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; connect-src 'self' https://api.spotify.com; media-src 'self'"></head><body><div id="remote" class="device" data-current-view="player"><div data-panel="player"><div class="player-background"><div class="player-background-shade"></div></div></div><div data-panel="settings"></div></div><p>https://peekabu411.github.io/</p></body></html>''')
        (source / 'bridge.js').write_text('async function load(file){}\nawait load("./app.js?v=I.9.8-viewport-resume");\n')
        (source / 'app.js').write_text('''function render(track, playback, remote) {
  remote.classList.toggle("is-playing", !!playback?.is_playing);
  console.log("all original playback logic remains");
}''')
        (source / 'sw.js').write_text('''const CACHE = "turntable-ios-i98-viewport-resume";
const ASSETS = ["./index.html", "./settings-help.js", "./preset-controls.js", "./manifest.webmanifest"];
''')
        (source / 'original-extra-feature.js').write_text('original queues and lyrics unaffected')
        (source / 'LICENSE').write_text('Preserve original author licence here')
        if bad:
            (source / 'app.js').write_text('changed upstream marker')
        return source

    def test_full_original_copy_with_additive_overlay_and_csp(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = self.create_upstream(root)
            dest = root / '_site'
            env = dict(os.environ, CANVAS_API_URL='https://canvas.example.org/api/canvas')
            run = subprocess.run([sys.executable, str(BUILD), str(source), str(dest)], text=True,
                                 capture_output=True, env=env)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual((dest / 'original-extra-feature.js').read_text(), 'original queues and lyrics unaffected')
            self.assertEqual((dest / 'LICENSE').read_text(), 'Preserve original author licence here')
            self.assertIn('window.turntableCanvasBackground?.syncTrack(track, !!playback?.is_playing)', (dest / 'app.js').read_text())
            self.assertIn('canvas-background.js', (dest / 'bridge.js').read_text())
            self.assertIn('https://sivarann.github.io/spotydesk.github.io/', (dest / 'index.html').read_text())
            self.assertNotIn('https://peekabu411.github.io/', (dest / 'index.html').read_text())
            self.assertIn('https://canvas.example.org', (dest / 'index.html').read_text())
            self.assertIn('https://canvaz.scdn.co', (dest / 'index.html').read_text())
            self.assertIn('spotydesk-canvas-v1', (dest / 'sw.js').read_text())
            self.assertIn('canvas-config.json', (dest / 'sw.js').read_text())
            self.assertEqual(json.loads((dest / 'canvas-config.json').read_text())['endpoint'], 'https://canvas.example.org/api/canvas')
            self.assertTrue((dest / '.nojekyll').exists())

    def test_fails_instead_of_broken_partial_merge(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = self.create_upstream(root, bad=True)
            run = subprocess.run([sys.executable, str(BUILD), str(source), str(root / '_site')], text=True, capture_output=True)
            self.assertNotEqual(run.returncode, 0)
            self.assertIn('BUILD FAILED', run.stderr)

    def test_no_backend_still_publishes_original_fallback(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = self.create_upstream(root)
            env = dict(os.environ)
            env.pop('CANVAS_API_URL', None)
            run = subprocess.run([sys.executable, str(BUILD), str(source), str(root / '_site')],
                                 capture_output=True, text=True, env=env)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertEqual(json.loads((root / '_site' / 'canvas-config.json').read_text())['endpoint'], '')

    def test_rejects_secret_url(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = self.create_upstream(root)
            env = dict(os.environ, CANVAS_API_URL='https://user:password@canvas.example.org/api/canvas?cookie=secret')
            run = subprocess.run([sys.executable, str(BUILD), str(source), str(root / '_site')],
                                 capture_output=True, text=True, env=env)
            self.assertNotEqual(run.returncode, 0)
            self.assertIn('no cookie', run.stderr)


if __name__ == '__main__':
    unittest.main()
