# Cloud server example (CSCI 4830/6830, Fall 2026)

A Google Cloud VM as the server for your VR project, in one small Node program (`server.mjs`):

| Path | What it is |
|---|---|
| `/` | your web files from `public/` (a WebXR app works: it is HTTPS) |
| `/room` | a shared room over WebSocket: each message one client sends goes to every other client |
| `/api/chat` | Gemini on your Google Cloud credits. POST `{ "message", "session", "persona", "json" }`, get `{ "reply", "session" }` |
| `/api/health` | `{ ok, project, model }` |

Caddy sits in front on ports 80 and 443 and gets an HTTPS certificate for the VM's IP address from Let's Encrypt
(6-day certificates, renewed on its own). The VM's service account signs the Gemini calls, so there is no API key.

## Set up (on the VM, after creating it as in the class tutorial)

```bash
sudo apt-get install -y git
git clone https://github.com/ugavrclass2026/CloudServerExample2026.git vrserver
cd vrserver && ./setup.sh
```

`setup.sh` prints your address (`https://<IP>`). Run it again whenever the VM's IP changes (after a stop and start).
No HTTPS? `./tunnel.sh` gives a temporary `https://….trycloudflare.com` address instead.

For Gemini, once per project, in Cloud Shell:

```bash
gcloud services enable aiplatform.googleapis.com
P=$(gcloud config get-value project)
N=$(gcloud projects describe "$P" --format='value(projectNumber)')
gcloud projects add-iam-policy-binding "$P" --member="serviceAccount:$N-compute@developer.gserviceaccount.com" \
  --role=roles/aiplatform.user --condition=None
```

The VM also needs **Access scopes: Allow full access to all Cloud APIs** (set when creating it, or stop it and edit).

## Change it

- Your files: put them in `public/` (they are served as they are, no restart)
- The server: edit `server.mjs`, then `sudo systemctl restart vrserver`; logs: `journalctl -u vrserver -f`
- The model: `MODEL` in `server.mjs` (default `gemini-3.5-flash`)
- Unity: `unity/ServerChat.cs` (`UnityWebRequest` to `/api/chat`)

## Cost

The e2-micro VM, 30 GB standard disk and 1 GB of traffic a month are in Google Cloud's free tier (us-west1,
us-central1, us-east1). The external IP address and Gemini are paid from your credits. Anyone who finds your
address can call `/api/chat`, so it allows 20 requests a minute per address; change that in `server.mjs`.
Delete the VM (or the whole project) when you're done.
