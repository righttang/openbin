#!/usr/bin/env python3
"""Build and exercise native iOS against the existing local test PostgreSQL server."""
import datetime
import json
import pathlib
import plistlib
import subprocess
import urllib.parse
import urllib.request

repo = pathlib.Path(__file__).resolve().parents[2]
env = dict(line.split('=', 1) for line in (repo / '.env').read_text().splitlines() if '=' in line and not line.lstrip().startswith('#'))
db = urllib.parse.urlparse(env.get('DATABASE_URL', '').strip('"\''))
if db.hostname not in ('localhost', '127.0.0.1') or 'test' not in db.path:
    raise SystemExit('This script requires a localhost PostgreSQL test database in .env')
profile = json.load(urllib.request.urlopen('http://127.0.0.1:1453/api/auth/me'))
expected = env.get('REMINDME_LOCAL_USER_ID', '5f46266f-66ea-4a9a-9b8d-d50bb8aa4558').strip('"\'')
if profile['id'] != expected:
    raise SystemExit('Local test profile differs from .env; refusing fixture writes')
devices = json.loads(subprocess.check_output(['xcrun', 'simctl', 'list', 'devices', 'available', '-j']))
phones = [d for group in devices['devices'].values() for d in group if d['name'] == 'RemindMe QA']
if not phones:
    raise SystemExit('Create a dedicated iPhone simulator named RemindMe QA in Xcode before running local UI tests')
device = phones[0]
destination = 'platform=iOS Simulator,id=' + device['udid']
subprocess.run(['xcodebuild', '-project', 'ios/RemindMe.xcodeproj', '-scheme', 'RemindMe', '-configuration', 'Debug', '-sdk', 'iphonesimulator', '-destination', destination, '-derivedDataPath', 'ios/build', 'build-for-testing'], cwd=repo, check=True)
runfile = max((repo / 'ios/build/Build/Products').glob('*.xctestrun'), key=lambda p: p.stat().st_mtime)
data = plistlib.loads(runfile.read_bytes())
targets = data.values() if 'TestConfigurations' not in data else [t for c in data['TestConfigurations'] for t in c['TestTargets']]
for target in targets:
    if not isinstance(target, dict) or target.get('BlueprintName') not in ('RemindMeTests', 'RemindMeUITests'):
        continue
    target.setdefault('EnvironmentVariables', {}).update(REMINDME_RUN_API_TESTS='1', REMINDME_RUN_UI_TESTS='1', REMINDME_EXPECT_TEST_PROFILE=expected)
runfile.write_bytes(plistlib.dumps(data))
result = repo / 'ios/build' / ('Local-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S') + '.xcresult')
subprocess.run(['xcodebuild', 'test-without-building', '-xctestrun', str(runfile), '-destination', destination, '-parallel-testing-enabled', 'NO', '-resultBundlePath', str(result)], cwd=repo, check=True)
print('Verified native app. XCTest results:', result)
