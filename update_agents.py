#!/usr/bin/env python3
import os
import sys

agent_dir = 'agents'
for slug in os.listdir(agent_dir):
    agent_md = os.path.join(agent_dir, slug, 'agent.md')
    if not os.path.isfile(agent_md):
        continue
    with open(agent_md, 'r') as f:
        lines = f.readlines()
    updated = False
    for i, line in enumerate(lines):
        if line.strip().startswith('1. Open that project\'s root `sitemap.md` — especially **Active Work** and **Known Issues**.'):
            lines[i] = '1. Open that project\'s root `sitemap.md` — especially **Active Work** and **Known Issues**. If missing, create a minimal sitemap with Overview, Structure, Key Integrations, Active Work, Known Issues sections.\n'
            updated = True
    if updated:
        with open(agent_md, 'w') as f:
            f.writelines(lines)
        print(f'Updated {slug}')
    else:
        print(f'Pattern not found in {slug}')