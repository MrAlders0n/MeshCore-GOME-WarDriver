# MeshMapper API Setup Guide

This guide explains how to configure the MeshMapper API key for automatic posting of ping data.

## Overview

Every time a ping is sent via the MeshCore WarDriver, the application automatically posts the same data to the YOW MeshMapper API at `https://yow.meshmapper.net/wardriving-api.php`. This helps track whether messages were received on the mesh network.

## Important: You Do NOT Need to Edit Code

**You do not need to edit any code files to configure the API key.** The key is automatically injected during deployment from GitHub Secrets. Just follow the steps below to add the secret.

## Setting Up the API Key

The API key needs to be configured as a GitHub Secret so it can be injected during deployment while keeping it secure.

### Step 1: Get Your API Key

Contact the MeshMapper administrator to obtain your API key.

### Step 2: Add the API Key to GitHub Secrets

1. Go to your GitHub repository
2. Click on **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Set the name as: `MESHMAPPER_API_KEY`
5. Paste your API key in the **Secret** field
6. Click **Add secret**

### Step 3: Deploy

The GitHub Actions workflow (`.github/workflows/deploy.yml`) will automatically:
- Create `content/config.js` with your API key from the secret
- Deploy the site to GitHub Pages with the key properly configured

## Local Development

For local development without the API key:

1. Copy the template:
   ```bash
   cp content/config.template.js content/config.js
   ```

2. Edit `content/config.js` and replace `YOUR_API_KEY_HERE` with your actual API key

3. The `content/config.js` file is in `.gitignore` so it won't be committed

## API Payload

The application posts the following data to the MeshMapper API:

```json
{
  "key": "YOUR_API_KEY",
  "lat": 45.264055,
  "lon": -75.705366,
  "who": "DeviceName",
  "power": "0.3w",
  "test": 1
}
```

Where:
- `key`: Your MeshMapper API key
- `lat`: GPS latitude coordinate
- `lon`: GPS longitude coordinate  
- `who`: Device name from MeshCore (or default "GOME-WarDriver")
- `power`: Radio power setting (N/A, 0.3w, 0.6w, or 1.0w)
- `test`: Always set to 1

## Troubleshooting

### API key not working

Check the browser console (F12) for messages like:
- "MeshMapper API key not configured, skipping API post" - API key is not set or is placeholder
- "Successfully posted to MeshMapper API" - Everything is working
- "Failed to post to MeshMapper API" - Network or API error (check error details)

### Local testing

If you want to test locally with a real API key:
1. Create `content/config.js` from the template
2. Add your API key
3. Open `index.html` in your browser (may need a local web server for modules)

### Deployment issues

If the deployment fails:
1. Check that the GitHub Secret `MESHMAPPER_API_KEY` is set correctly
2. Verify the workflow has permissions to deploy to GitHub Pages
3. Check the Actions tab for detailed error logs
