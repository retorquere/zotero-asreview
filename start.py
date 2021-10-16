#!/usr/bin/env python3

import os, sys
import glob
import pathlib
import configparser
from lxml import etree
import subprocess

def install_proxy(xpi, profile):
  print(f'installing {xpi}')
  rdf = etree.parse(os.path.join(xpi, 'install.rdf'))
  xpi_id = rdf.xpath('/rdf:RDF/rdf:Description/em:id', namespaces={'rdf': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'em': 'http://www.mozilla.org/2004/em-rdf#'})[0].text
  proxy = os.path.join(profile, 'extensions', xpi_id)
  if not os.path.isdir(os.path.dirname(proxy)):
    os.mkdir
    os.makedirs(os.path.dirname(proxy))
  elif os.path.isdir(proxy) and not os.path.islink(proxy):
    shutil.rmtree(proxy)
  elif os.path.exists(proxy):
    os.remove(proxy)
  with open(proxy, 'w') as f:
    f.write(xpi)

  with open(os.path.join(profile, 'prefs.js'), 'r+') as f:
    print('stripping prefs.js')
    lines = f.readlines()
    f.seek(0)
    for line in lines:
      if 'extensions.lastAppBuildId' in line: continue
      if 'extensions.lastAppVersion' in line: continue
      f.write(line)
    f.truncate()

profiles = configparser.ConfigParser()
profiles.read(str(pathlib.Path.home().joinpath('Library/Application Support/Zotero/profiles.ini')))
profile = None
for section in profiles:
  if sys.argv[1] == profiles[section].get('Name'):
    profile = profiles[section]['Path']
    break

print(profile)
#glob(".mozilla/firefox/*default-release*/")

def run(cmd):
  if type(cmd) == str:
    cmd = cmd.split(' ')
  print(subprocess.run(cmd, stdout=subprocess.PIPE).stdout.decode('utf-8'))

run('npm run build')
install_proxy('build', profile)
run('/Applications/Zotero.app/Contents/MacOS/zotero -P BBTZ5TEST -datadir profile -purgecaches -jsconsole -ZoteroDebugText > ~/.BBTZ5TEST.log &
