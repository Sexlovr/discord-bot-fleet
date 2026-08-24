#!/usr/bin/env python3
"""Add pushNow() calls to all mutation API routes."""
import os, re

ROUTES = [
    ('src/app/api/bots/route.ts', 'POST', 'create'),
    ('src/app/api/bots/[id]/route.ts', 'PUT', 'update'),
    ('src/app/api/bots/[id]/route.ts', 'DELETE', 'delete'),
    ('src/app/api/bots/[id]/start/route.ts', 'POST', 'start'),
    ('src/app/api/bots/[id]/stop/route.ts', 'POST', 'stop'),
    ('src/app/api/bots/[id]/restart/route.ts', 'POST', 'restart'),
    ('src/app/api/bots/[id]/clear-context/route.ts', 'POST', 'clear-context'),
    ('src/app/api/bots/clear-all-context/route.ts', 'POST', 'clear-all'),
    ('src/app/api/bots/stop-all/route.ts', 'POST', 'stop-all'),
]

for path, method, name in ROUTES:
    if not os.path.exists(path):
        print(f"SKIP (not found): {path}")
        continue
    with open(path, 'r') as f:
        content = f.read()
    
    if 'pushNow' in content:
        print(f"SKIP (already has pushNow): {path}")
        continue
    
    # Add import
    if "from '@/lib/hf-persist'" not in content and 'from "@/lib/hf-persist"' not in content:
        # Add after the last import line
        lines = content.split('\n')
        last_import = 0
        for i, line in enumerate(lines):
            if line.startswith('import '):
                last_import = i
        lines.insert(last_import + 1, "import { pushNow } from '@/lib/hf-persist';")
        content = '\n'.join(lines)
    
    # Add `await pushNow();` before the final return NextResponse.json
    # Pattern: "return NextResponse.json({ ok: true })"
    # or "return NextResponse.json({ bot: sanitizeBot(bot) });"
    if name == 'create':
        content = content.replace(
            "  return NextResponse.json({ ok: true, bot: sanitizeBot(bot) });",
            "  await pushNow();\n  return NextResponse.json({ ok: true, bot: sanitizeBot(bot) });"
        )
    elif name == 'update':
        # PUT returns NextResponse.json(sanitizeBot(updated)) or with _restart
        content = content.replace(
            "  return NextResponse.json(sanitizeBot(updated));",
            "  await pushNow();\n  return NextResponse.json(sanitizeBot(updated));"
        )
        # Also the version with _restart field
        content = content.replace(
            "  return NextResponse.json({\n    ...sanitizeBot(updated),",
            "  await pushNow();\n  return NextResponse.json({\n    ...sanitizeBot(updated),"
        )
    elif name == 'delete':
        content = content.replace(
            "  return NextResponse.json({ ok: true });",
            "  await pushNow();\n  return NextResponse.json({ ok: true });"
        )
    else:
        # start, stop, restart, clear-context, clear-all, stop-all
        content = content.replace(
            "  return NextResponse.json({ ok: true });",
            "  await pushNow();\n  return NextResponse.json({ ok: true });"
        )
        # Also handle the stop-all response with stopped/ids
        content = content.replace(
            "  return NextResponse.json({ ok: true, stopped: before.length, ids: before });",
            "  await pushNow();\n  return NextResponse.json({ ok: true, stopped: before.length, ids: before });"
        )
    
    with open(path, 'w') as f:
        f.write(content)
    print(f"PATCHED: {path} ({name})")

print("\nDone!")
