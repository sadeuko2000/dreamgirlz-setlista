# builds the crew version (Supabase backend) from the same page source as the claude.ai artifact
import re
src=open('/home/claude/setlista.html').read()
shim=open('/home/claude/ekipa/shim.js').read()
head='''<!doctype html>
<html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<style>[hidden]{display:none!important}</style>
</head><body>
'''
src=src.replace('<script src="https://cdn.jsdelivr.net/npm/webm-muxer@5.1.4/build/webm-muxer.js"></script>',
 '<script src="https://cdn.jsdelivr.net/npm/webm-muxer@5.1.4/build/webm-muxer.js"></script>\n<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js"></script>\n<script>\n'+shim+'\n</script>',1)
# drop the claude.ai-only connectivity probe
src=re.sub(r"  // one-off connectivity probe.*?\}\)\(\);\n","",src,flags=re.S)
out=head+src+'\n</body></html>\n'
open('/home/claude/ekipa/index.html','w').write(out)
print(len(out))
