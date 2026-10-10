import sys

with open('control-plane/lib/hub-memory.js', 'rb') as f:
    data = f.read()

lines = data.split(b'\\n')
# line 75 (0-index) is the template
orig = lines[74]  # zero-index 74 is line 75
# find b\"product\\\\'s\" in orig
idx = orig.find(b\"product\\\\'s\")
if idx == -1:
    print('pattern not found')
    sys.exit(1)
prefix = orig[:idx]
suffix = orig[idx + len(b\"product\\\\'s\"):]
# new line: prefix + b\"product\\\\'s sitemap for active work and known issues.\" + suffix
new_line = prefix + b\"product\\\\'s sitemap for active work and known issues.\" + suffix
lines[76] = new_line  # line 77 zero-index 76

with open('control-plane/lib/hub-memory.js', 'wb') as f:
    f.write(b'\\n'.join(lines))
print('fixed')