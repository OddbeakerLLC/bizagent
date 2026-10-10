#!/usr/bin/env python3
import sys

with open('control-plane/lib/hub-memory.js', 'r') as f:
    lines = f.readlines()

# line numbers are 1-indexed in text editors
# line 76: '`registry.json` is the source of truth...'
# line 77: 'use slugs only...'
if lines[75].rstrip() == "    '`registry.json` is the source of truth. Use each product\\\\'s `agent_name` when speaking to the operator;'," and \
   lines[76].rstrip() == "    'use slugs only in message file headers (`from:`, `to:`).',":
    # keep line 76 as is
    # insert new line after line 76
    lines.insert(77, "    'Before answering product status questions, refer to the product\\\\'s sitemap for active work and known issues.',\n")
    with open('control-plane/lib/hub-memory.js', 'w') as f:
        f.writelines(lines)
    print('Inserted sitemap line')
else:
    print('Lines did not match expected')
    sys.exit(1)