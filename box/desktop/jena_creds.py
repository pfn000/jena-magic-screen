#!/usr/bin/env python3
"""Private in-process credential reader for Jena. Never return values to logs, JSON or external handlers."""
import os, re, urllib.parse
PATH='/home/jena/.jena/auths.plexcode'
ENTRY=re.compile(r'^!!\s*([^|\n]+?)\s*\|\s*~!!\s*(\S+)\s*$',re.I)
FIELD=re.compile(r'^\s*([\w -]+)\s*:\s*(.+?)\s*$')

def parse(raw):
    entries=[]; current=None
    for line in raw.splitlines():
        m=ENTRY.match(line.strip())
        if m:
            if current and current.get('username') and current.get('password'): entries.append(current)
            current={'site':m.group(1).strip().lower(), 'domain':m.group(2).strip().lower()}
            continue
        if current:
            m=FIELD.match(line)
            if not m: continue
            key=m.group(1).strip().lower(); val=m.group(2).strip()
            if key in ('mail','email','user','username','login','account'): current['username']=val
            elif key in ('pass','password','passwd'): current['password']=val
    if current and current.get('username') and current.get('password'): entries.append(current)
    return entries

def vault_items():
    # mama's Accounts vault (dev panel), AES-GCM on disk; decrypted in memory only (jena_mamasec.entries)
    try:
        import jena_mamasec
        return [{'site':str(e.get('site','')).lower(),'domain':str(e.get('site','')).lower(),'username':e['username'],'password':e['password']}
                for e in jena_mamasec.entries() if e.get('username') and e.get('password')]
    except Exception:
        return []

def for_title(title):
    try: raw=open(PATH,encoding='utf-8').read()
    except (OSError, UnicodeError): raw=''
    title=(title or '').lower()
    if not re.search(r'log[ -]?in|sign[ -]?in|authenticat|password',title): return None
    for item in vault_items()+parse(raw):
        host=item['site'].removeprefix('https://').removeprefix('http://').removeprefix('www.').split('/')[0].removeprefix('www.')
        brand=host.split('.')[0]
        if len(brand)>2 and (brand in title or host in title): return item
    return None
