"""Linux test harness. The load driver and mock upstream are outside the measured group.
The backend (including its threads and descendants) enters its group before exec.
Failure to apply a requested cgroup limit is a test failure, never a silent fallback.
"""
from __future__ import annotations
import json, os, pathlib, signal, socket, subprocess, time, uuid

MIB = 1024 * 1024

def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]

def pairs(path: pathlib.Path) -> dict:
    try:
        return {line.split()[0]: int(line.split()[1]) for line in path.read_text().splitlines() if len(line.split()) == 2}
    except (FileNotFoundError, PermissionError):
        return {}

class Process:
    def __init__(self, command: list[str], env: dict[str, str], directory: pathlib.Path, memory_mib: int = 0):
        directory.mkdir(parents=True, exist_ok=True)
        self.log_path = directory / 'process.log'
        self.log = self.log_path.open('wb')
        self.group = None
        self.samples = []
        self.max_rss_kib = 0
        self.started = time.monotonic()
        self.memory_mib = memory_mib
        if memory_mib:
            root = pathlib.Path('/sys/fs/cgroup')
            if os.geteuid() != 0 or not (root / 'cgroup.controllers').exists():
                raise RuntimeError('requested enforced memory limit requires root and cgroup v2')
            available = (root / 'cgroup.controllers').read_text().split()
            if not {'cpu', 'memory'}.issubset(available):
                raise RuntimeError('cpu and memory controllers are unavailable')
            with (root / 'cgroup.subtree_control').open('w') as stream:
                stream.write('+memory +cpu')
            self.group = root / ('vtbm-test-' + uuid.uuid4().hex)
            self.group.mkdir()
            (self.group / 'memory.max').write_text(str(memory_mib * MIB))
            (self.group / 'memory.swap.max').write_text('0')
            (self.group / 'memory.oom.group').write_text('1')
            (self.group / 'cpu.max').write_text('100000 100000')
        group = self.group
        def enter():
            if group is not None:
                (group / 'cgroup.procs').write_text('0')
        self.process = subprocess.Popen(command, env=env, stdout=self.log, stderr=subprocess.STDOUT,
                                        preexec_fn=enter if group else None, start_new_session=True)
        self.sample()

    def sample(self):
        rss = 0
        try:
            status = pathlib.Path(f'/proc/{self.process.pid}/status').read_text()
            fields = {line.split(':', 1)[0]: line.split(':', 1)[1].strip().split()[0] for line in status.splitlines() if ':' in line and line.split(':', 1)[1].strip()}
            rss = int(fields.get('VmRSS', 0))
            self.max_rss_kib = max(self.max_rss_kib, int(fields.get('VmHWM', 0)), rss)
        except (FileNotFoundError, ProcessLookupError):
            pass
        value = int((self.group / 'memory.current').read_text()) if self.group else None
        self.samples.append({'t': round(time.monotonic() - self.started, 3), 'rssKiB': rss, 'cgroupBytes': value})
        return value

    def wait(self, timeout: float = 90):
        end = time.monotonic() + timeout
        while self.process.poll() is None:
            self.sample()
            if time.monotonic() > end:
                self.stop()
                raise TimeoutError(f'process deadline exceeded; see {self.log_path}')
            time.sleep(.005)
        self.sample()
        self.log.flush()
        return self.process.returncode

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=4)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL)
                self.process.wait(timeout=4)
        self.log.flush()

    def report(self) -> dict:
        self.sample()
        return {
            'pid': self.process.pid,
            'returnCode': self.process.poll(),
            'memoryLimitMiB': self.memory_mib or None,
            'limitEnforced': self.group is not None,
            'swapMaxBytes': 0 if self.group else None,
            'cpuQuotaCores': 1 if self.group else None,
            'peakRssKiB': self.max_rss_kib,
            'cgroupPeakBytes': int((self.group / 'memory.peak').read_text()) if self.group else None,
            'memoryEvents': pairs(self.group / 'memory.events') if self.group else {},
            'cpuStat': pairs(self.group / 'cpu.stat') if self.group else {},
            'lastMemoryStat': pairs(self.group / 'memory.stat') if self.group else {},
            'elapsedSeconds': round(time.monotonic() - self.started, 4),
            'log': str(self.log_path),
        }

    def close(self):
        self.stop()
        result = self.report()
        self.log.close()
        if self.group:
            for _ in range(50):
                try:
                    self.group.rmdir()
                    break
                except OSError:
                    time.sleep(.02)
        return result

    def records(self):
        result = []
        for line in self.log_path.read_text(errors='replace').splitlines():
            try:
                result.append(json.loads(line))
            except ValueError:
                pass
        return result
