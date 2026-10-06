# Storage Manager — Phase 4

The existing Storage application now adds **Disks and I/O** alongside the existing
volume, folder and application usage views. It reuses authenticated, server-scoped
SSH helpers and opens the existing file browser with its existing permissions.
No partition, format, mount or filesystem mutation operations are added.

## Measurement model

- The summary counts mounted persistent filesystems once, not the sum of disks,
  partitions and logical layers. Unmounted/reserved partitions appear in the
  topology when enumerated but do not add writable space to the summary.
- Linux uses `/sys/class/block` for device identities, partition parents, backing
  devices and capacities. Disk counters are sampled over at least 250 ms; kernel
  sectors use 512-byte units. Device disappearance and counter resets are unknown,
  never fabricated zero activity. Loop, RAM and zram devices are excluded.
- Windows uses `Get-Disk` / `Get-Partition` and volume GUID access paths to link
  existing Win32 volume capacity to a partition. Physical-disk performance counters
  supply per-disk I/O. Partition I/O is unavailable on this adapter.
- Shared/stacked storage can represent the same bytes multiple times. Neither
  topology capacity nor I/O is summed across layers. Unknown/unmapped devices stay
  visible without invented relationships. Exotic pools/dynamic disks may require
  dedicated adapters; no complete pool accounting is claimed.
- A failed Windows volume measurement now retains that volume with null values and
  makes the whole-server total unavailable, rather than silently omitting it.
- Capacity, free space, available space and filesystem-reserved space retain their
  existing distinct meanings. Folder scans keep their bounded allocated-byte and
  partial-result behavior; they are not interchangeable with filesystem usage.

The topology response is limited to 512 public metadata rows. Serial numbers,
private device objects and credentials are not sent in topology responses. Older
agents still supply the existing volume views, with an explicit missing-topology
notice. Updated agents must be installed through the normal provisioning flow.

## Local verification

`npm run lab` on port 3280 exposes actual local Windows disks, partitions, volume
capacity and I/O through the restricted local SSH target. The lab additionally
permits read-only file browsing and bounded folder scans beneath its own
`data/server-lab/sample-files` directory. A volume-root view points only to that
fixture and explicitly says it is not a scan of the entire volume. Example files
are created only if missing. Existing host files are not imported into the fixture.

Storage tests cover disk/volume relationships, duplicate mounts, inaccessible
capacity, missing/reset counters, stale results, legacy agents and response field
limits. Windows topology is exercised live and with deterministic doubles. Linux
sysfs behavior uses fixtures here; live Linux validation still requires a Linux host.
Runtime host observations and QA output remain in ignored `data/` and `outputs/`.

```powershell
npm test
npm run check
npm run lint
npm run build
powershell -NoProfile -File tests/windows-storage.test.ps1
python tests/test_storage_topology.py
```
