const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('ALB process identity requires the expected script, instance, and port',()=>{
  const script=`. '${path.join(root,'scripts','alb-processes.ps1').replaceAll("'","''")}';
if(-not (Test-AlbTargetCommandLine '"C:\\Program Files\\nodejs\\node.exe" scripts/alb-target.js motorlog-b 3102' 'motorlog-b' 3102)){exit 1}
if(Test-AlbTargetCommandLine 'node scripts/alb-target.js motorlog-a 3101' 'motorlog-b' 3102){exit 2}
if(Test-AlbTargetCommandLine 'node unrelated.js motorlog-b 3102' 'motorlog-b' 3102){exit 3}`;
  const result=spawnSync('powershell',['-NoProfile','-Command',script],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr||result.stdout);
});

test('ALB lifecycle discovers listeners and never stops a manifest PID directly',()=>{
  const helper=read('scripts/alb-processes.ps1');
  const start=read('scripts/start-alb-targets.ps1');
  const restart=read('scripts/restart-alb-targets.ps1');
  const verify=read('scripts/verify-alb.ps1');
  assert.match(helper,/Get-NetTCPConnection/);
  assert.match(helper,/Get-CimInstance Win32_Process/);
  assert.match(helper,/Test-AlbTargetCommandLine/);
  assert.match(helper,/Sync-AlbTargetManifest/);
  assert.match(restart,/Stop-AlbTarget/);
  assert.match(verify,/Stop-AlbTarget 'motorlog-b' 3102/);
  assert.doesNotMatch(start,/Get-Content[^\n]+alb-targets\.json/);
  assert.doesNotMatch(restart,/Get-Content[^\n]+alb-targets\.json/);
});

test('Run C initiates failover at an observed k6 load stage and always recovers',()=>{
  const run=read('scripts/run-load-tests.ps1');
  assert.match(run,/Start-LoggedNativeProcess \$k6Path/);
  assert.doesNotMatch(run,/Start-Process[^\n]+k6/);
  assert.match(run,/Invoke-RestMethod[^\n]+\/v1\/status/);
  assert.match(run,/Wait-K6FailoverStage/);
  assert.match(run,/status\.data\.attributes\.vus/);
  assert.match(run,/Stop-AlbTarget 'motorlog-b' 3102/);
  assert.match(run,/Wait-TargetHealth 3102 unhealthy/);
  assert.match(run,/Confirm-SurvivorTraffic/);
  assert.match(run,/finally\s*\{/);
  assert.match(run,/start-alb-targets\.ps1/);
  assert.match(run,/foreach\(\$port in 3101,3102,3103\)\{Wait-TargetHealth \$port healthy\}/);
  assert.match(run,/dist\/k6-run-\$Run\.json/);
});

test('ProcessStartInfo runner retains a concrete exit code and drains both logs',()=>{
  const helper=path.join(root,'scripts','process-execution.ps1').replaceAll("'","''");
  const prefix=path.join(os.tmpdir(),`motorlog-process-exit-${process.pid}`);
  const child=`${prefix}-child.ps1`,fixture=`${prefix}-runner.ps1`,stdout=`${prefix}.out.log`,stderr=`${prefix}.err.log`;
  const script=`. '${helper}';
$context=Start-LoggedNativeProcess (Get-Command powershell.exe).Source @('-NoProfile','-File','${child.replaceAll("'","''")}') '${root.replaceAll("'","''")}' '${stdout.replaceAll("'","''")}' '${stderr.replaceAll("'","''")}';
$code=Complete-LoggedNativeProcess $context 15 'regression-child';
if($code -ne 7){exit 1}
if((Get-Content -Raw '${stdout.replaceAll("'","''")}') -notmatch 'stdout-ok'){exit 2}
if((Get-Content -Raw '${stderr.replaceAll("'","''")}') -notmatch 'stderr-ok'){exit 3}`;
  fs.writeFileSync(child,"Write-Output 'stdout-ok'\n[Console]::Error.WriteLine('stderr-ok')\nexit 7\n",'utf8');
  fs.writeFileSync(fixture,script,'utf8');
  try{
    const result=spawnSync('powershell',['-NoProfile','-File',fixture],{cwd:root,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr||result.stdout);
  }finally{for(const file of [child,fixture,stdout,stderr])fs.rmSync(file,{force:true});}
});
