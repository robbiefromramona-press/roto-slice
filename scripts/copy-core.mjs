// Copies the ffmpeg.wasm core files out of node_modules into public/ffmpeg/.
// The two small, PATCHED files (ffmpeg-core.js, the worker) are self-hosted. The two
// ~31 MB ffmpeg-core.wasm files are NOT copied: Cloudflare Pages refuses files over
// 25 MiB, so src/engine.js loads them from jsDelivr at a pinned exact version and
// checks their SHA-384 before use (the patches only touch the JS, never the wasm).
// Runs automatically before `npm run dev` and `npm run build`.
//
// It also applies TWO patches to ffmpeg-core.js. Both exist because of big files.
//
// PATCH 1 -- fast reads (WORKERFS read-ahead)
//   ffmpeg reads the user's video in ~32 KB sips. Stock WORKERFS turns every
//   sip into its own trip to the browser's file reader, and each trip costs
//   about 2 ms no matter how small it is (measured: 1500 x 32 KB reads = 3.3 s,
//   one 16 MB read = 21 ms). The patch reads ahead: 4 MB at a time when ffmpeg
//   is reading straight through, 256 KB when it is hopping around (so hopping
//   between keyframes does not drag the whole file off disk). It keeps the 4
//   most recent chunks per file.
//
// PATCH 2 -- outputs go to disk, not memory (SINKFS)
//   Stock ffmpeg.wasm can only write its output into memory, and the
//   multithreaded core has 1 GB in total. A 15-minute phone video with the
//   silences removed is bigger than that. SINKFS is a tiny write-to-disk
//   filesystem backed by the browser's private storage (OPFS): the page hands
//   it file handles, ffmpeg writes straight through them.
//     - mount('SINKFS', { files: [{ name, handle }] }, '/out')
//     - the file appears in listDir('/out') once it is ready to write
//     - deleteFile('/out/name') = "finished, flush and close it"
//       (the real file on disk is NOT deleted)
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const STOCK_READ =
  'read:function(stream,buffer,offset,length,position){if(position>=stream.node.size)return 0;var chunk=stream.node.contents.slice(position,position+length);var ab=WORKERFS.reader.readAsArrayBuffer(chunk);buffer.set(new Uint8Array(ab),offset);return chunk.size}';

const CACHED_READ =
  'read:function(stream,buffer,offset,length,position){' +
  'var node=stream.node,size=node.size;if(position>=size)return 0;' +
  'var end=Math.min(position+length,size),done=0,cache=node.rsCache||(node.rsCache=[]);' +
  'while(position<end){' +
  'var hit=null,seq=false,i,c,ce;' +
  'for(i=cache.length-1;i>=0;i--){c=cache[i];ce=c.base+c.data.length;' +
  'if(position>=c.base&&position<ce){hit=c;cache.splice(i,1);break}' +
  'if(position>=ce-65536&&position<=ce+1048576)seq=true}' +
  'if(!hit){var want=seq?4194304:262144;if(want<end-position)want=end-position;' +
  'hit={base:position,data:new Uint8Array(WORKERFS.reader.readAsArrayBuffer(node.contents.slice(position,Math.min(position+want,size))))}}' +
  'cache.push(hit);if(cache.length>4)cache.shift();' +
  'var from=position-hit.base,n=Math.min(end-position,hit.data.length-from);if(n<=0)break;' +
  'buffer.set(hit.data.subarray(from,from+n),offset+done);done+=n;position+=n}' +
  'return done}';

const SINKFS =
  'var SINKFS={open:[],' +
  'release:function(e){if(e&&e.h){try{e.h.flush()}catch(x){}try{e.h.close()}catch(x){}e.h=null}},' +
  'mount:function(mount){' +
  'SINKFS.open.forEach(SINKFS.release);SINKFS.open=[];' +
  'var root=SINKFS.createNode(null,"/",16895);' +
  '((mount.opts&&mount.opts.files)||[]).forEach(function(f){' +
  'f.handle.createSyncAccessHandle().then(function(h){h.truncate(0);var e={h:h,size:0};SINKFS.open.push(e);SINKFS.createNode(root,f.name,33206).entry=e},' +
  'function(err){console.error("SINKFS: could not open "+f.name,err)})});' +
  'return root},' +
  'createNode:function(parent,name,mode){var node=FS.createNode(parent,name,mode,0);node.mode=mode;node.node_ops=SINKFS.node_ops;node.stream_ops=SINKFS.stream_ops;node.timestamp=Date.now();' +
  'if(FS.isDir(mode))node.contents={};if(parent)parent.contents[name]=node;return node},' +
  'node_ops:{' +
  'getattr:function(node){var size=node.entry?node.entry.size:4096,t=new Date(node.timestamp);' +
  'return{dev:1,ino:node.id,mode:node.mode,nlink:1,uid:0,gid:0,rdev:0,size:size,atime:t,mtime:t,ctime:t,blksize:4096,blocks:Math.ceil(size/4096)}},' +
  'setattr:function(node,attr){if(attr.mode!==undefined)node.mode=attr.mode;if(attr.timestamp!==undefined)node.timestamp=attr.timestamp;' +
  'if(attr.size!==undefined&&node.entry){if(!node.entry.h)throw new FS.ErrnoError(29);node.entry.h.truncate(attr.size);node.entry.size=attr.size}},' +
  'lookup:function(parent,name){throw new FS.ErrnoError(44)},' +
  'mknod:function(parent,name,mode,dev){throw new FS.ErrnoError(63)},' +
  'rename:function(oldNode,newDir,newName){throw new FS.ErrnoError(63)},' +
  'unlink:function(parent,name){var n=parent.contents[name];if(n)SINKFS.release(n.entry);delete parent.contents[name]},' +
  'rmdir:function(parent,name){throw new FS.ErrnoError(63)},' +
  'readdir:function(node){return[".",".."].concat(Object.keys(node.contents))},' +
  'symlink:function(parent,newName,oldPath){throw new FS.ErrnoError(63)}},' +
  'stream_ops:{' +
  'read:function(stream,buffer,offset,length,position){var e=stream.node.entry;if(!e||!e.h)throw new FS.ErrnoError(29);if(position>=e.size)return 0;' +
  'var n=Math.min(length,e.size-position);return e.h.read(buffer.subarray(offset,offset+n),{at:position})},' +
  'write:function(stream,buffer,offset,length,position){var e=stream.node.entry;if(!e||!e.h)throw new FS.ErrnoError(29);' +
  'var n=e.h.write(buffer.subarray(offset,offset+length),{at:position});if(position+n>e.size)e.size=position+n;return n},' +
  'llseek:function(stream,offset,whence){var position=offset;if(whence===1){position+=stream.position}else if(whence===2){if(FS.isFile(stream.node.mode)){position+=stream.node.entry.size}}' +
  'if(position<0){throw new FS.ErrnoError(28)}return position}}};';

const WORKERFS_DECL = 'var WORKERFS={';
const STOCK_REGISTRY = 'FS.filesystems={"MEMFS":MEMFS,"WORKERFS":WORKERFS}';
const PATCHED_REGISTRY = 'FS.filesystems={"MEMFS":MEMFS,"WORKERFS":WORKERFS,"SINKFS":SINKFS}';

function patch(js, label) {
  for (const [what, needle] of [['WORKERFS read', STOCK_READ], ['WORKERFS declaration', WORKERFS_DECL], ['filesystem registry', STOCK_REGISTRY]]) {
    if (js.split(needle).length !== 2) {
      throw new Error(
        `copy-core: expected exactly one "${what}" in ${label}. The @ffmpeg/core version ` +
        'probably changed -- update the patches in scripts/copy-core.mjs.',
      );
    }
  }
  return js
    .replace(STOCK_READ, () => CACHED_READ)
    .replace(WORKERFS_DECL, () => SINKFS + WORKERFS_DECL)
    .replace(STOCK_REGISTRY, () => PATCHED_REGISTRY);
}

const jobs = [
  ['@ffmpeg/core/dist/esm', 'st', ['ffmpeg-core.js']],
  ['@ffmpeg/core-mt/dist/esm', 'mt', ['ffmpeg-core.js', 'ffmpeg-core.worker.js']],
];
for (const [src, name, files] of jobs) {
  const outDir = join(root, 'public', 'ffmpeg', name);
  mkdirSync(outDir, { recursive: true });
  for (const f of files) {
    const from = join(root, 'node_modules', src, f);
    const to = join(outDir, f);
    if (f === 'ffmpeg-core.js') writeFileSync(to, patch(readFileSync(from, 'utf8'), `${src}/${f}`));
    else copyFileSync(from, to);
  }
  console.log(`ffmpeg ${name} core ready (read-ahead + disk-output patches applied)`);
}
