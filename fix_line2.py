import sys

with open('control-plane/lib/hub-memory.js', 'r') as f:
    lines = f.readlines()

# line 75 (0-index) is the original line with product\\'s
orig = lines[75]
# find the substring 'product\\'s'
idx = orig.find(\"product\\\\'s\")
if idx == -1:
    print('Could not find pattern')
    sys.exit(1)
# prefix is everything before 'product\\'s'
prefix = orig[:idx]
# suffix is everything after 'product\\'s' (including the rest of line)
suffix = orig[idx + len(\"product\\\\'s\"):]
# new line with same prefix and suffix but different middle
new_line = prefix + \"product\\\\'s sitemap for active work and known issues.\" + suffix
# replace line 77 (0-index 76) with new line
lines[76] = new_line

with open('control-plane/lib/hub-memory.js', 'w') as f:
    f.writelines(lines)
print('Replaced line 77')