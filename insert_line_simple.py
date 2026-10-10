import sys
import re

with open('control-plane/lib/hub-memory.js', 'r') as f:
    content = f.read()

# Find the line with 'Soft ops without a special ask'
lines = content.split('\\n')
for i, line in enumerate(lines):
    if 'Soft ops without a special ask' in line:
        # Insert after this line
        lines.insert(i + 1, \"   Before answering product status questions, refer to the product\\\\'s sitemap for active work and known issues.\")
        break

with open('control-plane/lib/hub-memory.js', 'w') as f:
    f.write('\\n'.join(lines))
print('Inserted line')