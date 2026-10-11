import re
from html import escape

with open('plan.md', 'r') as f:
    content = f.read()

# Extract metadata from header
meta = {}
m = re.search(r'Status: (\w+)', content)
meta['status'] = m.group(1) if m else 'unknown'
m = re.search(r'Cycle: (\d+) / (\d+)', content)
meta['cycles'] = (int(m.group(1)), int(m.group(2))) if m else (0, 3)
m = re.search(r'FeatureStarted: ([^\n]+)', content)
meta['started'] = m.group(1) if m else ''
m = re.search(r'OrchestrationTokensActual: ([\d,]+)', content)
meta['tokens'] = m.group(1) if m else '0'

# Parse task table using better regex
tasks_by_cycle = {0: [], 1: []}

# Match each task row: starts with |, then id (like T8, R8, etc), then |
task_pattern = r'\|\s*([A-Z]+\d+)\s*\|([^\|]+?)\|([^\|]+?)\|([^\|]+?)\|([^\|]+?)\|(\d)\s*\|'
for match in re.finditer(task_pattern, content):
    task_id = match.group(1)
    desc = match.group(2).strip()
    role = match.group(3).strip()
    depends = match.group(4).strip()
    status = match.group(5).strip()
    cycle = int(match.group(6))
    
    # Only include valid status values (exclude description fragments)
    if status in ['complete', 'in_progress', 'failed', 'not_run']:
        tasks_by_cycle[cycle].append({
            'id': task_id,
            'desc': desc[:80],
            'role': role,
            'status': status,
            'cycle': cycle
        })

# Extract cycle info
cycles = {}
for i in [0, 1]:
    cycles[i] = {'trigger': 'unknown', 'uat': 'unknown'}

m = re.search(r'### Cycle 0\n.*?Trigger: ([^\n]+)\n.*?UAT: (\w+)', content, re.DOTALL)
if m:
    cycles[0] = {'trigger': m.group(1), 'uat': m.group(2)}

m = re.search(r'### Cycle 1\n.*?Trigger: ([^\n]+)\n.*?UAT: (\w+)', content, re.DOTALL)
if m:
    cycles[1] = {'trigger': m.group(1), 'uat': m.group(2)}

# Print summary
print(f"Cycle 0: {len(tasks_by_cycle[0])} tasks")
for t in tasks_by_cycle[0]:
    print(f"  {t['id']}: {t['status']}")
print(f"Cycle 1: {len(tasks_by_cycle[1])} tasks")
for t in tasks_by_cycle[1]:
    print(f"  {t['id']}: {t['status']}")

