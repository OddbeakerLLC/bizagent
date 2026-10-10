import sys
with open('control-plane/lib/hub-memory.js', 'r') as f:
    lines = f.readlines()
# line index 76 is the inserted line (0-index)
lines[76] = \"    'Before answering product status questions, refer to the product\\\\'s sitemap for active work and known issues.',\\n\"
with open('control-plane/lib/hub-memory.js', 'w') as f:
    f.writelines(lines)
print('Fixed line')