"""Repeatable, renderer-only port of the reviewed illustrated direction."""
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT.parent / 'wookagent-alt' / 'src' / 'renderer' / 'src'
TARGET = ROOT / 'src' / 'renderer' / 'src'

FILES = (
    'studio/Office.tsx', 'studio/Person.tsx', 'studio/characters.ts',
    'studio/motion.ts', 'studio/motion.test.ts', 'styles/identity.css',
    'screens/Studio.tsx', 'screens/Simulation.tsx', 'screens/Settings.tsx',
    'screens/Home.tsx', 'screens/Documents.tsx', 'components/MemberPanel.tsx',
    'components/CommandBar.tsx', 'api/fake/officeDemo.ts',
)

for name in FILES:
    dest = TARGET / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SOURCE / name, dest)

app_css = TARGET / 'styles/app.css'
contents = app_css.read_text(encoding='utf-8')
for before, after in (
    ('linear-gradient(135deg, #e1e9d9, #f7e8ce)', '#e3e9dd'),
    ('linear-gradient(145deg, #304a3b, #526b4f)', '#d7d9cd'),
    ('repeating-linear-gradient(0deg, #c7aa79 0 18px, #bd9b70 18px 20px)', '#c7aa79'),
):
    contents = contents.replace(before, after)
app_css.write_text(contents, encoding='utf-8', newline='\n')

main = TARGET / 'main.tsx'
contents = main.read_text(encoding='utf-8').replace(
    "import './styles/terminal.css';", ''
)
if "import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';" not in contents:
    contents = contents.replace("import './styles/app.css';", "import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';\nimport './styles/app.css';")
main.write_text(contents, encoding='utf-8', newline='\n')

for name in ('studio/characters.tsx', 'styles/terminal.css'):
    (TARGET / name).unlink(missing_ok=True)
for path in (TARGET / 'assets/characters').glob('*.webp'):
    path.unlink()
