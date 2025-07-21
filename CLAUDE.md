# CLAUDE.md - AgriDrone Ops Platform Context

## 🚁 Project Overview
AgriDrone Ops is an agricultural drone operations platform for National Drones that processes drone imagery through AI-powered weed detection, converts detections to geographic coordinates, and exports data for spray drone operations.

**Key Capabilities:**
- Batch process thousands of drone images with EXIF metadata extraction
- AI-powered weed/crop detection using Roboflow models (wattle, lantana, bellyache bush, calitropis)
- Manual annotation for model training improvement  
- Pixel-to-geographic coordinate conversion using custom georeferencing algorithm
- Export coordinates as CSV/KML for spray drone operations
- Team collaboration and historical data comparison
- Chemical recommendations based on detected species

## 🏗️ Technical Architecture

### Tech Stack
- **Frontend**: Next.js 14, TypeScript, Tailwind CSS v3.4.15
- **Styling**: shadcn/ui components, green (agriculture) + blue (National Drones) theme
- **Authentication**: NextAuth.js (currently disabled for development)
- **Database**: Prisma ORM with SQLite (dev) / PostgreSQL (prod)
- **Image Processing**: Sharp, exifr for metadata extraction
- **Maps**: Mapbox/Leaflet for visualization
- **AI Integration**: Roboflow API (models: wattle, lantana, bellyache bush, calitropis)
- **Queue System**: BullMQ with Redis for batch processing
- **File Storage**: Local filesystem (dev) / S3-compatible (prod)

### Key Files & Directories
```
agri-drone-ops/
├── app/                    # Next.js 14 app directory
│   ├── page.tsx           # Beautiful landing page with gradients
│   ├── dashboard/         # Main dashboard (requires auth)
│   ├── test-dashboard/    # Dashboard without auth (for development)
│   └── api/              # API routes (to be implemented)
├── components/
│   └── ui/               # shadcn/ui components
├── lib/
│   └── utils/
│       └── georeferencing.ts  # Pixel-to-geo conversion algorithm
├── prisma/
│   └── schema.prisma     # Complete database schema
├── .github/
│   └── workflows/
│       └── claude.yml    # GitHub Actions for @claude mentions
└── CLAUDE.md            # This file - project context
```

## 🚀 Development Commands

### Essential Commands
```bash
# Start development server
npm run dev

# Build for production
npm run build

# Run production server
npm start

# Lint code (ALWAYS run before committing)
npm run lint

# Database commands
npx prisma generate      # Generate Prisma client
npx prisma migrate dev   # Run migrations
npx prisma studio       # Open database GUI

# Git workflow
git add .
git commit -m "Your message"
git push
```

### Common Tasks

**Access the application:**
- Landing page: http://localhost:3000
- Dashboard (no auth): http://localhost:3000/test-dashboard
- Dashboard (with auth): http://localhost:3000/dashboard

**Create a new page:**
```bash
# Create new file in app/your-page/page.tsx
# Import UI components from @/components/ui/*
# Use existing color scheme: green-500, blue-500, gradients
```

**Modify database schema:**
1. Edit `prisma/schema.prisma`
2. Run `npx prisma migrate dev --name your_migration_name`
3. Run `npx prisma generate`

## 🎨 Design System

### Color Scheme
- **Primary Green**: `green-500` to `green-600` (agriculture theme)
- **Primary Blue**: `blue-500` to `blue-600` (National Drones brand)
- **Gradients**: `bg-gradient-to-r from-green-500 to-blue-500`
- **Text Gradients**: `bg-gradient-to-r from-green-600 to-blue-600 bg-clip-text text-transparent`

### UI Components
All components use shadcn/ui. Import from `@/components/ui/*`:
- Button, Card, Input, Label, Select, Tabs, Toast, Dialog, etc.

### Styling Guidelines
- Use Tailwind CSS classes only (no custom CSS)
- Maintain consistent spacing: p-4, p-6, p-8
- Cards should have hover effects: `hover:shadow-lg transition-shadow`
- Important buttons use gradient backgrounds

## 🔧 Key Algorithms & Integration Points

### Georeferencing Algorithm (lib/utils/georeferencing.ts)
The user provided a custom `pixelToGeo` function that:
- Takes drone GPS position, gimbal angles, altitude
- Converts pixel coordinates to geographic coordinates
- Accounts for terrain height, lens distortion, laser rangefinder data
- Returns latitude/longitude for detected objects

**Key parameters needed:**
- GPS coordinates (lat/lon/alt)
- Gimbal angles (pitch, roll, yaw)
- Camera parameters (focal length, sensor size)
- Laser rangefinder distance (if available)

### Roboflow Integration (TO BE IMPLEMENTED)
**API Endpoint**: https://api.roboflow.com/
**Available Models**: 
- Wattle detection
- Lantana detection
- Bellyache bush detection
- Calitropis detection

**Required for each request:**
- API key (store in .env.local as ROBOFLOW_API_KEY)
- Model version ID
- Image data (base64 or URL)

### EXIF Metadata Extraction
Using `exifr` library to extract:
- GPS coordinates
- Altitude
- Camera make/model
- Gimbal angles (DJI-specific tags)
- Timestamp
- Laser rangefinder distance

## 🐛 Troubleshooting Guide

### Common Issues & Solutions

**1. Tailwind CSS not working (black & white only)**
```bash
# Ensure you're using Tailwind v3, not v4
npm uninstall tailwindcss postcss autoprefixer
npm install tailwindcss@^3.4.15 postcss autoprefixer
```

**2. Server won't start / connection refused**
```bash
# Check if port is in use
lsof -i :3000
# Try different port
PORT=3001 npm run dev
# Or kill existing process
kill -9 <PID>
```

**3. Authentication errors**
- Currently auth is disabled for development
- Access dashboard directly at /test-dashboard
- To enable auth, rename `app/auth-disabled` back to `app/auth`

**4. Database errors**
```bash
# Reset database
rm prisma/dev.db
npx prisma migrate dev
```

**5. Module not found errors**
```bash
# Clear cache and reinstall
rm -rf node_modules package-lock.json
npm install
```

## 📋 Current Implementation Status

### ✅ Completed
- Project setup with Next.js 14 and TypeScript
- Beautiful landing page with green/blue theme
- Dashboard UI with cards and stats
- Database schema for all entities
- Georeferencing utility functions
- Authentication system (NextAuth) - ready but disabled
- GitHub Actions integration for @claude mentions
- UI components library (shadcn/ui)

### 🚧 TODO - Priority Features
1. **Image Upload System**
   - Drag & drop interface
   - Batch upload support
   - Progress indicators
   - EXIF metadata extraction

2. **Roboflow Integration**
   - API client setup
   - Model selection interface
   - Batch processing queue
   - Results visualization

3. **Manual Annotation Interface**
   - Canvas-based drawing tools
   - Polygon/bounding box creation
   - Label management
   - Export for model training

4. **Map Visualization**
   - Mapbox/Leaflet integration
   - Detection overlay on satellite imagery
   - Coverage area calculations
   - Flight path visualization

5. **Export Functionality**
   - CSV generation with coordinates
   - KML file creation
   - Spray route optimization
   - Chemical quantity calculations

## 🔐 Environment Variables

Create `.env.local` with:
```env
# Database
DATABASE_URL="file:./dev.db"  # SQLite for dev

# Authentication
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="your-secret-here"  # Generate with: openssl rand -base64 32

# Roboflow
ROBOFLOW_API_KEY="your-api-key"
ROBOFLOW_WORKSPACE="your-workspace"

# Mapbox (optional)
NEXT_PUBLIC_MAPBOX_TOKEN="your-mapbox-token"

# Redis (for job queue)
REDIS_URL="redis://localhost:6379"

# AWS S3 (for production file storage)
AWS_ACCESS_KEY_ID="your-key"
AWS_SECRET_ACCESS_KEY="your-secret"
AWS_REGION="ap-southeast-2"
S3_BUCKET="agridrone-uploads"
```

## 👥 GitHub Integration

The repository includes GitHub Actions workflow for @claude mentions:
- **Location**: `.github/workflows/claude.yml`
- **Trigger**: Mention @claude in issues or PRs
- **Setup Required**: Add `ANTHROPIC_API_KEY` to repository secrets

**How to use:**
1. Create an issue describing a feature/bug
2. Mention @claude in the description
3. Claude will automatically create a PR

## 📝 Important Notes for Future Claude Sessions

1. **User is "very limited as a developer"** - Provide complete, working solutions
2. **Batch processing is critical** - System must handle thousands of images
3. **Coordinate accuracy is paramount** - This data controls spray drones
4. **Beautiful UI is required** - Maintain green/blue theme throughout
5. **Test all code** - Run npm run lint before committing

## 🚨 Security Considerations

1. **Never commit secrets** - Use environment variables
2. **Validate all uploads** - Check file types and sizes
3. **Sanitize coordinates** - Ensure they're within valid ranges
4. **Rate limit API calls** - Especially Roboflow endpoints
5. **Secure file storage** - Set proper permissions

## 🔗 Useful Links

- **Repository**: https://github.com/nationaldronesau/agri-drone-ops
- **Roboflow Docs**: https://docs.roboflow.com/
- **Next.js Docs**: https://nextjs.org/docs
- **Prisma Docs**: https://www.prisma.io/docs
- **shadcn/ui**: https://ui.shadcn.com/

---

**Last Updated**: ${new Date().toISOString().split('T')[0]}
**Updated By**: Claude Code Assistant

Remember: This is an agricultural platform where accuracy matters - coordinates generated here will be used by actual spray drones in the field!