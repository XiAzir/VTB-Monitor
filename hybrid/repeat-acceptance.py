#!/usr/bin/env python3
"""Repeat the identical real UI/Pi integration with one memory mechanism ablated.
Mock provider/load driver remain outside the measured backend cgroup. No images
are dropped or resized. A failing negative-control run is reported, never hidden.
"""
from __future__ import annotations
import argparse, json, os, pathlib, random, shutil, statistics, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--repetitions', type=int, default=3)
    p.add_argument('--memory-mib', type=int, default=150)
    p.add_argument('--binary', default='rust/target/release/vtb-monitor-rs')
    args=p.parse_args()
    if not 1 <= args.repetitions <= 10 or args.memory_mib <= 0: p.error('enforced positive limit and 1..10 repetitions required')
    result_dir=ROOT/'hybrid/results'; matrix=result_dir/'ablation'; matrix.mkdir(parents=True,exist_ok=True)
    cases=[(mode, rep) for mode in ['default','with_request_boundary_gc'] for rep in range(args.repetitions)]
    random.Random(20260912).shuffle(cases)
    runs=[]
    for mode, rep in cases:
        dest=matrix/f'{mode}-{rep+1}'; dest.mkdir(exist_ok=True)
        report_path=result_dir/'acceptance.json'; report_path.unlink(missing_ok=True)
        env={**os.environ, 'VTBM_REQUEST_GC': '1' if mode=='with_request_boundary_gc' else '0'}
        with (dest/'driver.log').open('w') as log:
            run=subprocess.run([sys.executable,'hybrid/acceptance.py','--binary',args.binary,'--memory-mib',str(args.memory_mib)],
                cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=180)
        data=json.loads(report_path.read_text()) if report_path.exists() else {'passed':False,'error':'missing acceptance report'}
        for name in ['acceptance.json','memory-samples.json','schedule-job.json','login-response.json','pi-chat.txt','process/process.log']:
            source=result_dir/name
            if source.exists():
                target=dest/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
        process=data.get('process',{})
        record={'mode':mode,'repetition':rep+1,'returnCode':run.returncode,'passed':data.get('passed',False),
            'checks':data.get('checks',[]),'providerRequests':data.get('providerRequests',[]),
            'cgroupPeakMiB':process.get('cgroupPeakBytes',0)/(1024*1024),
            'limitEnforced':process.get('limitEnforced',False),'memoryEvents':process.get('memoryEvents',{}),
            'elapsedSeconds':process.get('elapsedSeconds'), 'report':str(dest.relative_to(ROOT)/'acceptance.json')}
        runs.append(record); print(json.dumps(record,ensure_ascii=False),flush=True)
    summary={}
    for mode in ['default','with_request_boundary_gc']:
        rows=[r for r in runs if r['mode']==mode]
        summary[mode]={'runs':len(rows),'passed':sum(r['passed'] for r in rows),
            'peakMiBMedian':statistics.median(r['cgroupPeakMiB'] for r in rows),
            'peakMiBMaximum':max(r['cgroupPeakMiB'] for r in rows),
            'oomKills':sum(r['memoryEvents'].get('oom_kill',0) for r in rows)}
    output={'scope':'Original Svelte UI and TypeScript Pi/SDK, actual Rust queue, same synthetic 9 MiB image, CPU=1, no swap',
        'changedFactor':'Only VTBM_REQUEST_GC; SDK terminal submission behavior is identical in both groups',
        'limits':'Short deterministic integration, not 24-hour production certification, not Rust-vs-Node comparison',
        'summary':summary,'runs':runs}
    (matrix/'summary.json').write_text(json.dumps(output,ensure_ascii=False,indent=2))
    print('HYBRID_REPEATED_SUMMARY='+json.dumps(summary),flush=True)
    if summary['default']['passed'] != args.repetitions: raise SystemExit('default full-backend acceptance did not pass every repetition')

if __name__=='__main__': main()
