#!/usr/bin/env python3
"""Run component ablations with identical fixtures and compare semantic digests.
This is not an old-Node vs new-Rust end-to-end benchmark. See acceptance.py for
HTTP/business replay. Memory limits and workload completion are independent checks.
"""
from __future__ import annotations
import argparse, base64, hashlib, json, os, pathlib, platform, random, shutil, sqlite3, statistics, subprocess, tempfile, time
from harness import Process, MIB

MODES = ['optimized', 'buffer_media', 'eager_images', 'collect_rows', 'parallel_ai', 'all_disabled']

def make_fixtures(root: pathlib.Path):
    root.mkdir(parents=True)
    chunk = bytes(range(256)) * 256
    with (root / 'media.bin').open('wb') as f:
        for _ in range(384):
            f.write(chunk)
        f.flush(); os.fsync(f.fileno())
    for i in range(8):
        with (root / f'image-{i}.bin').open('wb') as f:
            for _ in range(48):
                f.write(bytes([i]) * len(chunk))
            f.flush(); os.fsync(f.fileno())
    db = sqlite3.connect(root / 'seed.sqlite')
    db.execute('CREATE TABLE bench_rows(id INTEGER PRIMARY KEY,payload TEXT NOT NULL)')
    payload = 'abcdef0123456789' * 1024
    db.executemany('INSERT INTO bench_rows VALUES(?,?)', ((i, payload) for i in range(6000)))
    db.commit(); db.close()
    # Ask the OS to discard clean fixture pages; never globally drop host caches.
    for path in root.iterdir():
        if hasattr(os, 'posix_fadvise'):
            with path.open('rb') as f:
                os.posix_fadvise(f.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)

def run(args):
    binary = pathlib.Path(args.binary).resolve().with_name('vtbm-ablation')
    if not binary.is_file():
        raise RuntimeError('build vtbm-ablation with --features bench-ablation first')
    output = pathlib.Path('rust/results'); output.mkdir(parents=True, exist_ok=True)
    results = []
    expected = None
    failed_optimized = False
    with tempfile.TemporaryDirectory(prefix='vtbm-ablation-') as temp:
        root = pathlib.Path(temp)
        fixture = root / 'fixture'; make_fixtures(fixture)
        order = [(rep, mode) for rep in range(args.repetitions) for mode in MODES]
        random.Random(20260912).shuffle(order)
        for rep, mode in order:
            run_dir = root / f'{rep}-{mode}'; run_dir.mkdir()
            db_path = run_dir / 'vtb-monitor.sqlite'
            shutil.copyfile(fixture / 'seed.sqlite', db_path)
            if hasattr(os, 'posix_fadvise'):
                with db_path.open('rb') as f:
                    os.posix_fadvise(f.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
            env = {**os.environ, 'DATA_DIR': str(run_dir), 'BENCH_FIXTURE': str(fixture),
                   'DATABASE_PATH': str(db_path), 'APP_ENCRYPTION_KEY': base64.b64encode(b'B'*32).decode(),
                   'DISABLE_SCHEDULER': '1', 'MALLOC_ARENA_MAX': '2'}
            for key in ('ADMIN_INITIAL_PASSWORD', 'BILI_MOCK_ORIGIN', 'MEDIA_DIR'):
                env.pop(key, None)
            log_dir = output / f'ablation-{rep}-{mode}'
            process = Process([str(binary), mode], env, log_dir, args.memory_mib)
            try:
                process.wait(90)
                records = [r for r in process.records() if r.get('completed')]
                report = process.report()
                payload = records[-1] if records else None
                if payload is not None:
                    if expected is None:
                        expected = payload['digests']
                    report['sameOutput'] = payload['digests'] == expected
                else:
                    report['sameOutput'] = False
                report.update({'mode': mode, 'repetition': rep, 'workloadCompleted': payload is not None,
                               'measurements': payload, 'log': str(log_dir / 'process.log')})
                results.append(report)
                (log_dir / 'samples.json').write_text(json.dumps(process.samples))
                if mode == 'optimized' and (not payload or not report['sameOutput'] or report['memoryEvents'].get('oom_kill', 0)):
                    failed_optimized = True
                print(json.dumps({'mode': mode, 'rep': rep, 'completed': payload is not None,
                                  'sameOutput': report['sameOutput'],
                                  'peakMiB': round(report['cgroupPeakBytes']/MIB, 3) if report['cgroupPeakBytes'] else None,
                                  'oomKill': report['memoryEvents'].get('oom_kill', 0)}), flush=True)
            finally:
                process.close()
    summary = {}
    for mode in MODES:
        group = [r for r in results if r['mode'] == mode]
        success = [r for r in group if r['workloadCompleted'] and r['sameOutput']]
        peaks = [r['cgroupPeakBytes']/MIB for r in group if r['cgroupPeakBytes'] is not None]
        summary[mode] = {'completedRuns': len(success), 'runs': len(group),
                         'cgroupPeakMiBMedian': statistics.median(peaks) if peaks else None,
                         'cgroupPeakMiBMaximum': max(peaks) if peaks else None,
                         'peakRssMiBMedian': statistics.median(r['peakRssKiB']/1024 for r in group),
                         'elapsedMsMedianCompleted': statistics.median(r['measurements']['elapsedMs'] for r in success) if success else None,
                         'oomKills': sum(r['memoryEvents'].get('oom_kill', 0) for r in group)}
    result = {'experiment': 'component ablation with real Rust application initialization',
              'claimBoundary': 'Not an old-backend comparison, not full feature parity or long-duration production certification.',
              'fixture': {'mediaTransfers': 4, 'eachMediaMiB': 24, 'images': 8, 'eachImageMiB': 3,
                          'archiveRows': 6000, 'archivePayloadBytesPerRow': 16384, 'aiPreparationJobs': 4},
              'platform': platform.platform(), 'cpuLimit': 1, 'memoryLimitMiB': args.memory_mib, 'swapLimitBytes': 0,
              'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
              'seed': 20260912, 'summary': summary, 'raw': results, 'optimizedPassed': not failed_optimized}
    (output / 'ablation.json').write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print('ABLATION_SUMMARY='+json.dumps(summary, ensure_ascii=False), flush=True)
    if failed_optimized:
        raise SystemExit('optimized configuration failed its budget or output-equivalence check')
    if any(r['workloadCompleted'] and not r['sameOutput'] for r in results):
        raise SystemExit('a completed ablation produced a different result')

if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--binary', required=True); p.add_argument('--repetitions', type=int, default=3)
    p.add_argument('--memory-mib', type=int, default=150); run(p.parse_args())
