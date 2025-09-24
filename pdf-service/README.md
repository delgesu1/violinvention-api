# PDF Service

Server-side PDF generation service using Playwright for true text-based PDFs.

## Features

- **Text-based PDFs**: Uses Playwright + Chrome for native PDF rendering (no rasterization)
- **High Performance**: Single browser instance with request queuing (3 concurrent max)
- **Optimized Output**: ~50-200KB PDFs vs ~1-4MB client-side alternatives
- **Graceful Shutdown**: Proper browser cleanup on service termination
- **Error Handling**: Comprehensive error responses with appropriate HTTP codes

## Local Development

```bash
cd pdf-service
npm install
npm run dev  # Uses nodemon for development
```

The service will start on port 3001 by default.

## API Endpoints

### POST /generate
Generate PDF from HTML content.

**Request Body:**
```json
{
  "html": "<html>...</html>",
  "title": "document-name"
}
```

**Response:** PDF file download

**Error Codes:**
- `400`: Missing or invalid HTML content
- `408`: Generation timeout (>20s)
- `500`: Internal generation error
- `503`: Service unavailable (browser not ready)

### GET /health
Service health check.

**Response:**
```json
{
  "status": "healthy",
  "browserReady": true,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Deployment Notes

- **Memory**: Requires at least 512MB RAM for Playwright browser
- **Timeout**: PDF generation times out after 20 seconds
- **Concurrency**: Limited to 3 concurrent requests via semaphore
- **Browser Args**: Optimized for containerized environments

## Integration

The main API (`/api/v1/pdf/generate`) proxies requests to this service with:
- Authentication validation
- Error handling and response mapping
- Proper HTTP status code translation
- Request timeout management (25s total)

## Architecture Benefits

1. **Separation of Concerns**: PDF generation isolated from main API
2. **Resource Management**: Dedicated service for memory-intensive operations
3. **Scalability**: Can scale PDF service independently
4. **Reliability**: Main API remains responsive even during PDF generation load