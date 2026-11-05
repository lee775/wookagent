"""Capture the local Vite preview at 1440px through an Edge instance owned by this script."""
import asyncio
import base64
import json
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

import websockets

EDGE = Path(r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')
PORT = 9223


async def capture(name: str, query: str, script: str = '', expected_once: str = ''):
    profile = Path(tempfile.mkdtemp(prefix='wook-capture-'))
    proc = subprocess.Popen([
        str(EDGE), '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run',
        '--remote-allow-origins=*', f'--remote-debugging-port={PORT}',
        f'--user-data-dir={profile}', '--window-size=1440,900', 'about:blank',
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        target = None
        for _ in range(60):
            try:
                targets = json.load(urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json', timeout=1))
                target = next((item for item in targets if item['type'] == 'page'), None)
                if target:
                    break
            except (OSError, ValueError):
                pass
            await asyncio.sleep(.1)
        if not target:
            raise RuntimeError('Edge CDP page unavailable')
        async with websockets.connect(target['webSocketDebuggerUrl'], max_size=20_000_000) as ws:
            seq = 0

            async def command(method, params=None):
                nonlocal seq
                seq += 1
                await ws.send(json.dumps({'id': seq, 'method': method, 'params': params or {}}))
                while True:
                    message = json.loads(await ws.recv())
                    if message.get('id') == seq:
                        if 'error' in message:
                            raise RuntimeError(message['error'])
                        return message.get('result', {})

            await command('Page.enable')
            await command('Runtime.enable')
            await command('Emulation.setDeviceMetricsOverride', {'width': 1440, 'height': 900, 'deviceScaleFactor': 1, 'mobile': False})
            await command('Page.navigate', {'url': f'http://127.0.0.1:5196/?{query}'})
            await asyncio.sleep(2)
            await command('Runtime.evaluate', {'expression': "Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('개발 모드로 시작하기'))?.click()"})
            await asyncio.sleep(2)
            if script:
                for expression in script.split('|||'):
                    await command('Runtime.evaluate', {'expression': expression})
                    await asyncio.sleep(1)
            if expected_once:
                count = await command('Runtime.evaluate', {
                    'expression': f'document.body.innerText.split({json.dumps(expected_once, ensure_ascii=False)}).length - 1',
                    'returnByValue': True,
                })
                if count.get('result', {}).get('value') != 1:
                    raise AssertionError(f'Expected one routing note, found {count.get("result", {}).get("value")}')
            data = await command('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
            output = Path(__file__).resolve().parent / name
            output.write_bytes(base64.b64decode(data['data']))
            print(output)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == '__main__':
    asyncio.run(capture(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else '',
                        sys.argv[4] if len(sys.argv) > 4 else ''))
