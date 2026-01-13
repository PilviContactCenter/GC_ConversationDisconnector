# Genesys Cloud Disconnect Tool

A modern web application for bulk disconnecting Genesys Cloud conversations with custom wrap-up codes.

![Preview](https://img.shields.io/badge/Built%20with-JavaScript-yellow) ![License](https://img.shields.io/badge/License-MIT-blue)

## Features

- 🎨 **Modern Dark UI** - Beautiful glassmorphism design with animated gradients
- 📁 **Drag & Drop CSV Import** - Easily upload files with Case IDs or Conversation IDs
- 🔄 **Real-time Progress** - Live tracking of disconnect operations
- 📊 **Activity Log** - Detailed logs with export functionality
- 🔐 **Secure** - Credentials stored locally in your browser
- 🌐 **Multi-Region Support** - Works with all Genesys Cloud regions

## Quick Start

### Prerequisites

- Node.js 16+ installed
- Genesys Cloud OAuth Client Credentials (Client Credentials Grant)

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/GenesysCloudDisconnectTool.git
   cd GenesysCloudDisconnectTool
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure credentials** (optional - can also enter in UI)
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

4. **Start the server**
   ```bash
   npm start
   ```

5. **Open in browser**
   ```
   http://localhost:3000
   ```

## Usage

1. **Connect** - Enter your Genesys Cloud OAuth credentials or use the pre-configured ones from `.env`

2. **Import CSV** - Drag & drop or click to select a CSV file containing:
   - **Case IDs** (external tags) - one per line
   - **Conversation IDs** - one per line

3. **Configure** - Set the wrap-up code, optional notes, and duration

4. **Process** - Click "Start Disconnect Process" to begin

## CSV Format

Your CSV file should contain one ID per line:

```csv
33b49719-db8d-4772-9efc-7159add2fe44
a1b2c3d4-e5f6-7890-abcd-ef1234567890
...
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GENESYS_CLOUD_CLIENT_ID` | OAuth Client ID | - |
| `GENESYS_CLOUD_CLIENT_SECRET` | OAuth Client Secret | - |
| `GENESYS_CLOUD_REGION` | Genesys Cloud region | `mypurecloud.de` |
| `PORT` | Server port | `3000` |

### Supported Regions

- Europe (Frankfurt) - `mypurecloud.de`
- Americas (US East) - `mypurecloud.com`
- EMEA (Dublin) - `mypurecloud.ie`
- APAC (Sydney) - `mypurecloud.com.au`
- APAC (Tokyo) - `mypurecloud.jp`
- Americas (US West) - `usw2.pure.cloud`
- Americas (Canada) - `cac1.pure.cloud`
- Americas (São Paulo) - `sae1.pure.cloud`
- EMEA (London) - `euw2.pure.cloud`
- APAC (Mumbai) - `aps1.pure.cloud`
- APAC (Seoul) - `apne2.pure.cloud`

## Required Permissions

Your OAuth client needs the following permissions:

- `conversation:communication:disconnect`
- `conversation:participant:wrapup`
- `analytics:conversationDetail:view`

## Tech Stack

- **Frontend**: Vanilla HTML, CSS, JavaScript
- **Backend**: Node.js, Express
- **API**: Genesys Cloud Platform API

## License

MIT License - see [LICENSE](LICENSE) for details.

---

**Proudly built by [Dawid Kacprzak](https://github.com/PilviContactCenter)**
