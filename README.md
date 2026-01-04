# AgriDrone Ops - Agricultural Drone Operations Platform

An AI-powered platform for agricultural drone operations. Upload drone imagery, detect weeds and crops using AI, manually annotate targets, and generate precise spray coordinates for your operations.

## Features

- 🚁 **Batch Image Upload** - Process thousands of drone images with automatic EXIF metadata extraction
- 🤖 **AI Detection** - Powered by Roboflow models trained on wattle, lantana, and more species
- 🎯 **Manual Annotation** - Draw polygons and bounding boxes for precise target identification
- 🗺️ **Geo-Coordinates** - Convert pixel detections to real-world GPS coordinates
- 👥 **Team Collaboration** - Create teams, manage permissions, and work together
- 📊 **Historical Analysis** - Compare farm data over time
- 💊 **Chemical Recommendations** - Get species-specific treatment suggestions
- 📥 **Export Options** - Generate CSV/KML/Shapefile files for spray drones and GIS software

## Tech Stack

- **Frontend**: Next.js 14, TypeScript, Tailwind CSS
- **Authentication**: NextAuth.js
- **Database**: PostgreSQL with Prisma ORM
- **Maps**: Mapbox/Leaflet
- **AI Integration**: Roboflow API
- **Queue System**: BullMQ with Redis
- **File Storage**: Local/S3 compatible

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL database
- Redis server (for job queue)
- Roboflow account and API key
- Mapbox access token (optional)

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd agri-drone-ops
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.local.example .env.local
```

Edit `.env.local` with your configuration:
- Database connection string
- NextAuth secret
- Roboflow API credentials
- Mapbox token
- Redis URL

4. Set up the database:
```bash
npx prisma generate
npx prisma migrate dev
```

5. Run the development server:
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the application.

## Project Structure

```
agri-drone-ops/
├── app/                    # Next.js app directory
│   ├── api/               # API routes
│   ├── auth/              # Authentication pages
│   └── dashboard/         # Main app pages
├── components/            # React components
│   ├── ui/               # Reusable UI components
│   ├── features/         # Feature-specific components
│   └── layout/           # Layout components
├── lib/                   # Utility functions
│   ├── auth/             # Authentication config
│   ├── db/               # Database client
│   └── utils/            # Helper functions
├── prisma/               # Database schema
└── public/               # Static assets
```

## Current Progress

✅ Project setup with Next.js and TypeScript
✅ Beautiful landing page with green/blue theme
✅ Authentication system with NextAuth
✅ Database schema design
✅ Georeferencing utilities integrated
✅ Image upload with EXIF metadata extraction
✅ Roboflow AI detection integration
✅ Manual annotation interface (polygon drawing)
✅ Interactive map visualization with filtering
✅ CSV/KML export for spray drones
✅ **Shapefile export** for DJI Terra & GIS software
✅ E2E testing framework (Playwright)

🚧 Next steps:
- User management & organizations
- AWS production deployment
- Orthomosaic tile processing

## Contributing

This is a private project for National Drones. Please contact the development team for access and contribution guidelines.

## License

Proprietary - National Drones © 2024-2026