import sys
with open('control-plane/lib/hub-memory.js', 'r') as f:
    lines = f.readlines()
print('Line 76:', repr(lines[75]))
print('Line 77:', repr(lines[76]))
print('Line 76 stripped:', repr(lines[75].rstrip()))
print('Line 77 stripped:', repr(lines[76].rstrip()))