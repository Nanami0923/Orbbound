import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {basename} from 'node:path';

const repository='Nanami0923/Orbbound';
const args=process.argv.slice(2);
const androidOnly=args.length===2 && args[0]==='--platform' && args[1]==='android';
if(args.length!==0 && !androidOnly)throw Error('Usage: node scripts/publish-release.mjs [--platform android]');
const rootVersion=JSON.parse(readFileSync('package.json','utf8')).version;
const androidVersion=JSON.parse(readFileSync('android/version.json','utf8')).version;
const version=androidOnly?androidVersion:rootVersion, tag=`v${version}`;
if(!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))throw Error(`Invalid release version: ${version}`);
const credential=spawnSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',windowsHide:true,timeout:15000});
const token=credential.stdout?.split('\n').find(line=>line.startsWith('password='))?.slice(9);
if(credential.status!==0 || !token)throw Error('GitHub authentication unavailable');
const headers={Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','User-Agent':'Orbbound-release','X-GitHub-Api-Version':'2022-11-28'};
async function api(path,method='GET',body){
  const response=await fetch(`https://api.github.com/repos/${repository}/${path}`,{method,headers:{...headers,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();
  if(!response.ok)throw Error(`${method} ${path}: ${response.status} ${result.message}`);
  return result;
}
const local=spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true});
if(local.status!==0)throw Error('Cannot read local release commit');
const sha=local.stdout.trim();
const ref=await api(`git/ref/tags/${tag}`);
const remoteCommit=ref.object.type==='tag'?(await api(`git/tags/${ref.object.sha}`)).object.sha:ref.object.sha;
if(remoteCommit!==sha)throw Error('Remote release tag does not match local commit');
const metadata=JSON.parse(readFileSync(`docs/releases/${version}-artifacts.json`,'utf8'));
if(metadata.version!==version)throw Error('Artifact metadata version mismatch');
const expectedArtifacts=androidOnly
  ? [{platform:'Android',file:`Orbbound-${version}-Android.apk`}]
  : [{platform:'Android',file:`Orbbound-${version}-Android.apk`},{platform:'Windows',file:`Orbbound-Windows-${version}-x64.zip`}];
const metadataArtifacts=Array.isArray(metadata.artifacts)?metadata.artifacts.map(({platform,file})=>`${platform}:${file}`).sort():[];
const expectedMetadataArtifacts=expectedArtifacts.map(({platform,file})=>`${platform}:${file}`).sort();
if(JSON.stringify(metadataArtifacts)!==JSON.stringify(expectedMetadataArtifacts))throw Error(`Artifact metadata must list exactly the ${androidOnly?'Android':'Android and Windows'} release artifacts`);
const notesBase=`https://github.com/${repository}/blob/${tag}/docs/releases/`;
const releaseBody=readFileSync(`docs/releases/${version}-notes.md`,'utf8').replace(/\]\(([^)]+)\)/g,(match,href)=>/^[a-z][a-z0-9+.-]*:/i.test(href)||href.startsWith('#')?match:`](${new URL(href,notesBase).href})`);
const androidApk=`最终交付/Android/Orbbound-${version}/Orbbound-${version}-Android.apk`;
const windowsArchive=`最终交付/Windows/Orbbound-Windows-${version}/Orbbound-Windows-${version}-x64.zip`;
const files=androidOnly
  ? [androidApk,`${androidApk}.sha256`,`docs/releases/${version}-artifacts.json`]
  : [androidApk,`${androidApk}.sha256`,windowsArchive,`${windowsArchive}.sha256`,`docs/releases/${version}-artifacts.json`];
for(const file of files.filter(file=>file.endsWith('.apk')||file.endsWith('.zip'))){
  const bytes=readFileSync(file),hash=createHash('sha256').update(bytes).digest('hex');
  const expected=metadata.artifacts.find(artifact=>artifact.file===basename(file));
  if(!expected||expected.bytes!==bytes.length||expected.sha256!==hash)throw Error(`Local artifact validation failed: ${basename(file)}`);
  if(readFileSync(`${file}.sha256`,'utf8').trim().split(/\s+/)[0]!==hash)throw Error(`Checksum sidecar mismatch: ${basename(file)}`);
}
const lookup=await fetch(`https://api.github.com/repos/${repository}/releases/tags/${tag}`,{headers});
let release;
if(lookup.status===404)release=await api('releases','POST',{tag_name:tag,target_commitish:sha,name:`Orbbound ${version} · ${metadata.title ?? 'Android / Windows'}`,body:releaseBody,draft:true,prerelease:metadata.prerelease===true});
else if(lookup.ok){release=await lookup.json();if(!release.draft)throw Error('Release is public; assets will not be replaced');}
else throw Error(`Release lookup failed: ${lookup.status}`);
for(const file of files){
  const bytes=readFileSync(file),name=basename(file),hash=createHash('sha256').update(bytes).digest('hex');
  const existing=(await api(`releases/${release.id}/assets`)).find(asset=>asset.name===name);
  if(existing){if(existing.size!==bytes.length||existing.digest!==`sha256:${hash}`)throw Error(`Existing draft asset mismatch: ${name}`);continue;}
  const response=await fetch(release.upload_url.replace(/\{.*$/,'')+`?name=${encodeURIComponent(name)}`,{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream'},body:bytes});
  const asset=await response.json();
  if(!response.ok)throw Error(`Upload ${name}: ${response.status} ${asset.message}`);
  if(asset.size!==bytes.length||asset.digest!==`sha256:${hash}`)throw Error(`Uploaded checksum mismatch: ${name}`);
  console.log(`Verified ${name} (${bytes.length} bytes)`);
}
// Refuse to publish a draft containing unrelated assets from an earlier attempt.
const draftAssets=await api(`releases/${release.id}/assets`);
const expectedAssets=new Map(files.map(file=>[basename(file),readFileSync(file)]));
if(draftAssets.length!==expectedAssets.size || draftAssets.some(asset=>{
  const bytes=expectedAssets.get(asset.name);
  return !bytes || asset.size!==bytes.length || asset.digest!==`sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}))throw Error('Draft assets must exactly match the selected release files before publication');
await api(`releases/${release.id}`,'PATCH',{draft:false,prerelease:metadata.prerelease===true,make_latest:metadata.prerelease===true?'false':'true'});
const published=await api(`releases/tags/${tag}`);
if(published.draft || published.prerelease!==(metadata.prerelease===true) || published.assets.length!==files.length)throw Error('Published release validation failed');
const result={url:published.html_url,tag:published.tag_name,commit:sha,prerelease:published.prerelease,assets:published.assets.map(asset=>({name:asset.name,size:asset.size,digest:asset.digest,url:asset.browser_download_url}))};
writeFileSync(`.build/published-${version}.json`,JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
