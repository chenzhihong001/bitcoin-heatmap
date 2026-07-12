# Server deployment

The collector is designed to run as a persistent Linux `systemd` service. It reads `.env.local`, reuses `data/telegram.session`, and writes to `data/liquidations.sqlite`.

## Current state

The collector is working locally. The Oracle Cloud VM has not been created yet because `VM.Standard.A1.Flex` was out of capacity in availability domain `AD-1`. The saved Oracle configuration can be retried later in another availability domain. Do not select a paid shape without reviewing its cost.

## Install on a VM

1. Copy the project to `/opt/bitcoin-heatmap`.
2. Install Node.js LTS and project dependencies with `npm ci`.
3. Copy the local `.env.local` to the server over an encrypted transfer. Never commit it.
4. Copy `data/telegram.session` to `/opt/bitcoin-heatmap/data/telegram.session` with owner-only permissions.
5. Create a dedicated service user:

```bash
sudo useradd --system --home /opt/bitcoin-heatmap --shell /usr/sbin/nologin bitcoinheatmap
sudo chown -R bitcoinheatmap:bitcoinheatmap /opt/bitcoin-heatmap
sudo chmod 600 /opt/bitcoin-heatmap/.env.local /opt/bitcoin-heatmap/data/telegram.session
```

6. Copy `liquidation-collector.service.example` to `/etc/systemd/system/liquidation-collector.service`.
7. Confirm the Node and npm paths in `ExecStart` for the server.
8. Start and enable the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now liquidation-collector
sudo systemctl status liquidation-collector
```

View logs with:

```bash
sudo journalctl -u liquidation-collector -f
```

The service restarts after a crash. Telegram message IDs and the SQLite uniqueness constraint make normal restarts safe from duplicate event inserts.

## Important

This repository does not contain a server host, SSH key, or cloud credentials. A VM must be created separately before these commands can be run remotely. Oracle Cloud Always Free is one possible zero-cost starting point, subject to its current availability and account requirements. Before creating the VM, confirm the final Oracle estimate and Always Free eligibility. Capacity availability does not guarantee free-tier eligibility.
