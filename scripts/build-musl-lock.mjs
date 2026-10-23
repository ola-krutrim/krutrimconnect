import {execFileSync} from 'node:child_process';
import {mkdirSync, existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
if(process.platform==='linux' && !process.report.getReport().header.glibcVersionRuntime) {
  const root=fileURLToPath(new URL('..',import.meta.url));
  const headers=path.resolve(path.dirname(process.execPath),'../include/node');
  if(!existsSync(path.join(headers,'node_api.h'))) throw Error('Musl builds require Node development headers on the build host.');
  mkdirSync(path.join(root,'dist'),{recursive:true});
  execFileSync('cc',['-shared','-fPIC','-O2','-Wall','-Wextra','-Werror',`-I${headers}`,path.join(root,'native/musl-lock.c'),'-o',path.join(root,'dist/musl-lock.node')],{stdio:'inherit'});
}
