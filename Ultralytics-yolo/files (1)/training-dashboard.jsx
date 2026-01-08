import React, { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, AreaChart, Area, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, BarChart, Bar } from 'recharts';

// Mock training data - would come from your API
const generateTrainingHistory = () => {
  const epochs = [];
  for (let i = 1; i <= 100; i++) {
    const progress = i / 100;
    const noise = () => (Math.random() - 0.5) * 0.05;
    epochs.push({
      epoch: i,
      mAP50: Math.min(0.95, 0.3 + progress * 0.6 + noise() * (1 - progress)),
      mAP5095: Math.min(0.75, 0.15 + progress * 0.55 + noise() * (1 - progress)),
      precision: Math.min(0.95, 0.4 + progress * 0.5 + noise() * (1 - progress)),
      recall: Math.min(0.92, 0.35 + progress * 0.52 + noise() * (1 - progress)),
      boxLoss: Math.max(0.02, 0.8 - progress * 0.7 + noise() * (1 - progress)),
      clsLoss: Math.max(0.01, 0.5 - progress * 0.45 + noise() * (1 - progress)),
      lr: 0.01 * Math.cos(progress * Math.PI * 0.5),
    });
  }
  return epochs;
};

const trainingHistory = generateTrainingHistory();

// Confusion Matrix Data
const confusionData = [
  { actual: 'Wattle', Wattle: 145, Lantana: 3, Bellyache: 2, Background: 5 },
  { actual: 'Lantana', Wattle: 4, Lantana: 132, Bellyache: 8, Background: 6 },
  { actual: 'Bellyache', Wattle: 1, Lantana: 5, Bellyache: 118, Background: 4 },
  { actual: 'Background', Wattle: 2, Lantana: 2, Bellyache: 1, Background: 287 },
];

// Class Performance Data
const classPerformance = [
  { class: 'Wattle', precision: 0.94, recall: 0.92, f1: 0.93, support: 155 },
  { class: 'Lantana', precision: 0.89, recall: 0.88, f1: 0.885, support: 150 },
  { class: 'Bellyache Bush', precision: 0.91, recall: 0.92, f1: 0.915, support: 128 },
  { class: 'Calitropis', precision: 0.87, recall: 0.85, f1: 0.86, support: 98 },
];

// Radar chart data
const radarData = [
  { metric: 'mAP50', value: 0.912, fullMark: 1 },
  { metric: 'mAP50-95', value: 0.687, fullMark: 1 },
  { metric: 'Precision', value: 0.903, fullMark: 1 },
  { metric: 'Recall', value: 0.891, fullMark: 1 },
  { metric: 'F1 Score', value: 0.897, fullMark: 1 },
];

// Augmentation previews
const augmentationTypes = [
  { name: 'Original', transform: '', preview: '🖼️' },
  { name: 'H-Flip', transform: 'scaleX(-1)', preview: '↔️' },
  { name: 'V-Flip', transform: 'scaleY(-1)', preview: '↕️' },
  { name: 'Rotate 90°', transform: 'rotate(90deg)', preview: '🔄' },
  { name: 'Brightness+', transform: 'brightness(1.3)', preview: '☀️' },
  { name: 'Brightness-', transform: 'brightness(0.7)', preview: '🌙' },
  { name: 'Blur', transform: 'blur(2px)', preview: '💨' },
  { name: 'Saturation', transform: 'saturate(1.5)', preview: '🎨' },
];

export default function ModelTrainingDashboard() {
  const [activeTab, setActiveTab] = useState('training');
  const [isTraining, setIsTraining] = useState(false);
  const [currentEpoch, setCurrentEpoch] = useState(0);
  const [selectedPreset, setSelectedPreset] = useState('agricultural');
  const [augConfig, setAugConfig] = useState({
    horizontalFlip: true,
    verticalFlip: true,
    rotation: 180,
    brightness: 30,
    saturation: 30,
    blur: true,
    shadow: true,
    copiesPerImage: 3,
  });

  // Simulate training progress
  useEffect(() => {
    if (isTraining && currentEpoch < 100) {
      const timer = setTimeout(() => {
        setCurrentEpoch(prev => prev + 1);
      }, 150);
      return () => clearTimeout(timer);
    }
  }, [isTraining, currentEpoch]);

  const currentMetrics = trainingHistory[Math.min(currentEpoch, 99)] || trainingHistory[0];
  const visibleHistory = trainingHistory.slice(0, currentEpoch + 1);

  return (
    <div className="min-h-screen bg-[#0a0f1a] text-white font-['JetBrains_Mono',monospace]">
      {/* Import fonts */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap');
        
        .glow-green { text-shadow: 0 0 20px rgba(34, 197, 94, 0.5); }
        .glow-blue { text-shadow: 0 0 20px rgba(59, 130, 246, 0.5); }
        .glow-orange { text-shadow: 0 0 20px rgba(249, 115, 22, 0.5); }
        
        .glass {
          background: rgba(255, 255, 255, 0.03);
          backdrop-filter: blur(10px);
          border: 1px solid rgba(255, 255, 255, 0.08);
        }
        
        .metric-card {
          background: linear-gradient(135deg, rgba(34, 197, 94, 0.1) 0%, rgba(59, 130, 246, 0.1) 100%);
          border: 1px solid rgba(34, 197, 94, 0.2);
        }
        
        .pulse-ring {
          animation: pulse-ring 2s cubic-bezier(0.455, 0.03, 0.515, 0.955) infinite;
        }
        
        @keyframes pulse-ring {
          0% { transform: scale(0.8); opacity: 0.5; }
          50% { transform: scale(1); opacity: 0.3; }
          100% { transform: scale(0.8); opacity: 0.5; }
        }
        
        .gradient-border {
          background: linear-gradient(135deg, #22c55e, #3b82f6);
          padding: 1px;
        }
        
        .gradient-border-inner {
          background: #0a0f1a;
        }
        
        .train-btn {
          background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%);
          box-shadow: 0 4px 20px rgba(34, 197, 94, 0.4);
          transition: all 0.3s ease;
        }
        
        .train-btn:hover {
          transform: translateY(-2px);
          box-shadow: 0 6px 30px rgba(34, 197, 94, 0.6);
        }
        
        .stop-btn {
          background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
          box-shadow: 0 4px 20px rgba(239, 68, 68, 0.4);
        }
        
        .aug-card {
          transition: all 0.3s ease;
        }
        
        .aug-card:hover {
          transform: scale(1.05);
          border-color: rgba(34, 197, 94, 0.5);
        }
        
        input[type="range"] {
          -webkit-appearance: none;
          background: rgba(255,255,255,0.1);
          border-radius: 10px;
          height: 6px;
        }
        
        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 16px;
          height: 16px;
          background: linear-gradient(135deg, #22c55e, #3b82f6);
          border-radius: 50%;
          cursor: pointer;
        }
      `}</style>

      {/* Header */}
      <header className="border-b border-white/10 px-6 py-4">
        <div className="max-w-[1800px] mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-green-500 to-blue-500 flex items-center justify-center text-lg">
              🧠
            </div>
            <div>
              <h1 className="text-xl font-semibold font-['Space_Grotesk',sans-serif] bg-gradient-to-r from-green-400 to-blue-400 bg-clip-text text-transparent">
                Model Training Studio
              </h1>
              <p className="text-xs text-white/40">YOLO11 • Agricultural Weed Detection</p>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            <div className="glass rounded-lg px-4 py-2 flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${isTraining ? 'bg-green-500 animate-pulse' : 'bg-white/30'}`} />
              <span className="text-sm text-white/60">
                {isTraining ? 'Training Active' : 'Ready'}
              </span>
            </div>
            <div className="glass rounded-lg px-4 py-2">
              <span className="text-sm text-white/60">GPU: </span>
              <span className="text-green-400 text-sm">Tesla T4 (15GB)</span>
            </div>
          </div>
        </div>
      </header>

      {/* Navigation Tabs */}
      <nav className="border-b border-white/10 px-6">
        <div className="max-w-[1800px] mx-auto flex gap-1">
          {[
            { id: 'training', label: 'Training', icon: '📊' },
            { id: 'augmentation', label: 'Augmentation', icon: '🎨' },
            { id: 'results', label: 'Results & Metrics', icon: '🎯' },
            { id: 'models', label: 'Model Registry', icon: '📦' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-5 py-3 text-sm font-medium transition-all relative ${
                activeTab === tab.id 
                  ? 'text-white' 
                  : 'text-white/40 hover:text-white/70'
              }`}
            >
              <span className="mr-2">{tab.icon}</span>
              {tab.label}
              {activeTab === tab.id && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-green-500 to-blue-500" />
              )}
            </button>
          ))}
        </div>
      </nav>

      {/* Main Content */}
      <main className="p-6 max-w-[1800px] mx-auto">
        
        {/* Training Tab */}
        {activeTab === 'training' && (
          <div className="space-y-6">
            {/* Control Panel */}
            <div className="grid grid-cols-4 gap-4">
              {/* Dataset Info */}
              <div className="glass rounded-2xl p-5">
                <div className="text-white/40 text-xs uppercase tracking-wider mb-3">Dataset</div>
                <div className="text-2xl font-semibold mb-1">1,247</div>
                <div className="text-white/50 text-sm">Training Images</div>
                <div className="mt-4 flex gap-2">
                  <span className="px-2 py-1 rounded-md bg-green-500/20 text-green-400 text-xs">Wattle: 423</span>
                  <span className="px-2 py-1 rounded-md bg-orange-500/20 text-orange-400 text-xs">Lantana: 389</span>
                </div>
              </div>

              {/* Model Config */}
              <div className="glass rounded-2xl p-5">
                <div className="text-white/40 text-xs uppercase tracking-wider mb-3">Base Model</div>
                <select className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm mb-3">
                  <option value="yolo11n">YOLO11n (Nano) - 2.6M params</option>
                  <option value="yolo11s">YOLO11s (Small) - 9.4M params</option>
                  <option value="yolo11m" selected>YOLO11m (Medium) - 20.1M params</option>
                  <option value="yolo11l">YOLO11l (Large) - 43.7M params</option>
                  <option value="yolo11x">YOLO11x (XLarge) - 56.9M params</option>
                </select>
                <div className="flex justify-between text-xs text-white/40">
                  <span>Speed ←</span>
                  <span>→ Accuracy</span>
                </div>
              </div>

              {/* Training Params */}
              <div className="glass rounded-2xl p-5">
                <div className="text-white/40 text-xs uppercase tracking-wider mb-3">Parameters</div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <label className="text-white/40 text-xs">Epochs</label>
                    <input type="number" defaultValue={100} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 mt-1" />
                  </div>
                  <div>
                    <label className="text-white/40 text-xs">Batch Size</label>
                    <input type="number" defaultValue={16} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 mt-1" />
                  </div>
                  <div>
                    <label className="text-white/40 text-xs">Image Size</label>
                    <input type="number" defaultValue={640} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 mt-1" />
                  </div>
                  <div>
                    <label className="text-white/40 text-xs">Learning Rate</label>
                    <input type="number" defaultValue={0.01} step={0.001} className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 mt-1" />
                  </div>
                </div>
              </div>

              {/* Start/Stop */}
              <div className="glass rounded-2xl p-5 flex flex-col justify-between">
                <div className="text-white/40 text-xs uppercase tracking-wider mb-3">Control</div>
                {!isTraining ? (
                  <button 
                    onClick={() => { setIsTraining(true); setCurrentEpoch(0); }}
                    className="train-btn w-full py-4 rounded-xl font-semibold text-white flex items-center justify-center gap-2"
                  >
                    <span className="text-xl">▶</span>
                    Start Training
                  </button>
                ) : (
                  <button 
                    onClick={() => setIsTraining(false)}
                    className="stop-btn w-full py-4 rounded-xl font-semibold text-white flex items-center justify-center gap-2"
                  >
                    <span className="text-xl">■</span>
                    Stop Training
                  </button>
                )}
                <div className="text-center text-xs text-white/40 mt-2">
                  Est. time: ~45 minutes
                </div>
              </div>
            </div>

            {/* Progress Section */}
            {(isTraining || currentEpoch > 0) && (
              <div className="glass rounded-2xl p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-4">
                    <div className="relative">
                      <div className="w-16 h-16 rounded-full bg-gradient-to-br from-green-500/20 to-blue-500/20 flex items-center justify-center">
                        <span className="text-2xl font-bold">{currentEpoch}</span>
                      </div>
                      {isTraining && (
                        <div className="absolute inset-0 rounded-full border-2 border-green-500/50 pulse-ring" />
                      )}
                    </div>
                    <div>
                      <div className="text-lg font-semibold">Epoch {currentEpoch} / 100</div>
                      <div className="text-white/40 text-sm">
                        {isTraining ? 'Training in progress...' : 'Training paused'}
                      </div>
                    </div>
                  </div>
                  
                  {/* Live Metrics */}
                  <div className="flex gap-6">
                    <div className="text-center">
                      <div className="text-2xl font-bold text-green-400 glow-green">
                        {(currentMetrics.mAP50 * 100).toFixed(1)}%
                      </div>
                      <div className="text-xs text-white/40">mAP50</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-bold text-blue-400 glow-blue">
                        {(currentMetrics.precision * 100).toFixed(1)}%
                      </div>
                      <div className="text-xs text-white/40">Precision</div>
                    </div>
                    <div className="text-center">
                      <div className="text-2xl font-bold text-orange-400 glow-orange">
                        {(currentMetrics.recall * 100).toFixed(1)}%
                      </div>
                      <div className="text-xs text-white/40">Recall</div>
                    </div>
                  </div>
                </div>

                {/* Progress Bar */}
                <div className="h-2 bg-white/10 rounded-full overflow-hidden mb-6">
                  <div 
                    className="h-full bg-gradient-to-r from-green-500 to-blue-500 transition-all duration-300"
                    style={{ width: `${currentEpoch}%` }}
                  />
                </div>

                {/* Charts */}
                <div className="grid grid-cols-2 gap-6">
                  {/* mAP Chart */}
                  <div>
                    <div className="text-sm text-white/60 mb-3">Mean Average Precision</div>
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={visibleHistory}>
                          <defs>
                            <linearGradient id="mapGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3}/>
                              <stop offset="95%" stopColor="#22c55e" stopOpacity={0}/>
                            </linearGradient>
                            <linearGradient id="map95Gradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                              <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                          <XAxis dataKey="epoch" stroke="rgba(255,255,255,0.3)" fontSize={10} />
                          <YAxis domain={[0, 1]} stroke="rgba(255,255,255,0.3)" fontSize={10} />
                          <Tooltip 
                            contentStyle={{ 
                              background: 'rgba(10, 15, 26, 0.9)', 
                              border: '1px solid rgba(255,255,255,0.1)',
                              borderRadius: '8px'
                            }}
                          />
                          <Area type="monotone" dataKey="mAP50" stroke="#22c55e" fill="url(#mapGradient)" strokeWidth={2} name="mAP50" />
                          <Area type="monotone" dataKey="mAP5095" stroke="#3b82f6" fill="url(#map95Gradient)" strokeWidth={2} name="mAP50-95" />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  {/* Loss Chart */}
                  <div>
                    <div className="text-sm text-white/60 mb-3">Training Loss</div>
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={visibleHistory}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                          <XAxis dataKey="epoch" stroke="rgba(255,255,255,0.3)" fontSize={10} />
                          <YAxis stroke="rgba(255,255,255,0.3)" fontSize={10} />
                          <Tooltip 
                            contentStyle={{ 
                              background: 'rgba(10, 15, 26, 0.9)', 
                              border: '1px solid rgba(255,255,255,0.1)',
                              borderRadius: '8px'
                            }}
                          />
                          <Line type="monotone" dataKey="boxLoss" stroke="#f97316" strokeWidth={2} dot={false} name="Box Loss" />
                          <Line type="monotone" dataKey="clsLoss" stroke="#a855f7" strokeWidth={2} dot={false} name="Class Loss" />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Sample Predictions */}
            {currentEpoch > 20 && (
              <div className="glass rounded-2xl p-6">
                <div className="text-sm text-white/60 mb-4">Validation Predictions (Live)</div>
                <div className="grid grid-cols-4 gap-4">
                  {[1, 2, 3, 4].map(i => (
                    <div key={i} className="relative aspect-square rounded-xl overflow-hidden bg-gradient-to-br from-green-900/30 to-blue-900/30">
                      <div className="absolute inset-0 flex items-center justify-center text-4xl opacity-30">🌿</div>
                      {/* Simulated bounding boxes */}
                      <div className="absolute top-[20%] left-[15%] w-[30%] h-[25%] border-2 border-green-500 rounded" />
                      <div className="absolute top-[50%] left-[55%] w-[25%] h-[30%] border-2 border-orange-500 rounded" />
                      <div className="absolute bottom-2 left-2 right-2 flex gap-1">
                        <span className="px-1.5 py-0.5 rounded bg-green-500/80 text-[10px]">Wattle 94%</span>
                        <span className="px-1.5 py-0.5 rounded bg-orange-500/80 text-[10px]">Lantana 87%</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Augmentation Tab */}
        {activeTab === 'augmentation' && (
          <div className="space-y-6">
            {/* Preset Selection */}
            <div className="glass rounded-2xl p-6">
              <div className="text-lg font-semibold mb-4 font-['Space_Grotesk',sans-serif]">Augmentation Preset</div>
              <div className="grid grid-cols-4 gap-4">
                {[
                  { id: 'light', name: 'Light', desc: 'Minimal changes', icon: '🌤️', augPerImg: 2 },
                  { id: 'medium', name: 'Medium', desc: 'Balanced variety', icon: '⚡', augPerImg: 3 },
                  { id: 'heavy', name: 'Heavy', desc: 'Maximum diversity', icon: '🔥', augPerImg: 5 },
                  { id: 'agricultural', name: 'Agricultural', desc: 'Optimized for drone imagery', icon: '🚁', augPerImg: 3 },
                ].map(preset => (
                  <button
                    key={preset.id}
                    onClick={() => setSelectedPreset(preset.id)}
                    className={`p-4 rounded-xl border-2 transition-all text-left ${
                      selectedPreset === preset.id
                        ? 'border-green-500 bg-green-500/10'
                        : 'border-white/10 hover:border-white/30'
                    }`}
                  >
                    <div className="text-2xl mb-2">{preset.icon}</div>
                    <div className="font-semibold">{preset.name}</div>
                    <div className="text-sm text-white/50">{preset.desc}</div>
                    <div className="text-xs text-green-400 mt-2">+{preset.augPerImg}x per image</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Custom Controls */}
            <div className="grid grid-cols-2 gap-6">
              <div className="glass rounded-2xl p-6">
                <div className="text-lg font-semibold mb-4 font-['Space_Grotesk',sans-serif]">Spatial Transforms</div>
                <div className="space-y-5">
                  <div className="flex items-center justify-between">
                    <span className="text-white/70">Horizontal Flip</span>
                    <button 
                      onClick={() => setAugConfig({...augConfig, horizontalFlip: !augConfig.horizontalFlip})}
                      className={`w-12 h-6 rounded-full transition-all ${augConfig.horizontalFlip ? 'bg-green-500' : 'bg-white/20'}`}
                    >
                      <div className={`w-5 h-5 rounded-full bg-white transition-all ${augConfig.horizontalFlip ? 'translate-x-6' : 'translate-x-0.5'}`} />
                    </button>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-white/70">Vertical Flip</span>
                    <button 
                      onClick={() => setAugConfig({...augConfig, verticalFlip: !augConfig.verticalFlip})}
                      className={`w-12 h-6 rounded-full transition-all ${augConfig.verticalFlip ? 'bg-green-500' : 'bg-white/20'}`}
                    >
                      <div className={`w-5 h-5 rounded-full bg-white transition-all ${augConfig.verticalFlip ? 'translate-x-6' : 'translate-x-0.5'}`} />
                    </button>
                  </div>
                  <div>
                    <div className="flex justify-between mb-2">
                      <span className="text-white/70">Rotation</span>
                      <span className="text-green-400">±{augConfig.rotation}°</span>
                    </div>
                    <input 
                      type="range" 
                      min={0} 
                      max={180} 
                      value={augConfig.rotation}
                      onChange={(e) => setAugConfig({...augConfig, rotation: parseInt(e.target.value)})}
                      className="w-full"
                    />
                  </div>
                </div>
              </div>

              <div className="glass rounded-2xl p-6">
                <div className="text-lg font-semibold mb-4 font-['Space_Grotesk',sans-serif]">Color & Lighting</div>
                <div className="space-y-5">
                  <div>
                    <div className="flex justify-between mb-2">
                      <span className="text-white/70">Brightness</span>
                      <span className="text-green-400">±{augConfig.brightness}%</span>
                    </div>
                    <input 
                      type="range" 
                      min={0} 
                      max={50} 
                      value={augConfig.brightness}
                      onChange={(e) => setAugConfig({...augConfig, brightness: parseInt(e.target.value)})}
                      className="w-full"
                    />
                  </div>
                  <div>
                    <div className="flex justify-between mb-2">
                      <span className="text-white/70">Saturation</span>
                      <span className="text-green-400">±{augConfig.saturation}%</span>
                    </div>
                    <input 
                      type="range" 
                      min={0} 
                      max={50} 
                      value={augConfig.saturation}
                      onChange={(e) => setAugConfig({...augConfig, saturation: parseInt(e.target.value)})}
                      className="w-full"
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-white/70">Cloud Shadows</span>
                    <button 
                      onClick={() => setAugConfig({...augConfig, shadow: !augConfig.shadow})}
                      className={`w-12 h-6 rounded-full transition-all ${augConfig.shadow ? 'bg-green-500' : 'bg-white/20'}`}
                    >
                      <div className={`w-5 h-5 rounded-full bg-white transition-all ${augConfig.shadow ? 'translate-x-6' : 'translate-x-0.5'}`} />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Preview Grid */}
            <div className="glass rounded-2xl p-6">
              <div className="text-lg font-semibold mb-4 font-['Space_Grotesk',sans-serif]">Augmentation Preview</div>
              <div className="grid grid-cols-8 gap-3">
                {augmentationTypes.map((aug, i) => (
                  <div 
                    key={i}
                    className="aug-card aspect-square rounded-xl border border-white/10 overflow-hidden bg-gradient-to-br from-green-900/20 to-blue-900/20 flex flex-col"
                  >
                    <div 
                      className="flex-1 flex items-center justify-center text-4xl"
                      style={{ filter: aug.transform.includes('blur') || aug.transform.includes('brightness') || aug.transform.includes('saturate') ? aug.transform : undefined }}
                    >
                      <span style={{ transform: aug.transform.includes('scale') || aug.transform.includes('rotate') ? aug.transform : undefined }}>
                        🌿
                      </span>
                    </div>
                    <div className="text-center text-[10px] text-white/60 py-1 bg-black/30">
                      {aug.name}
                    </div>
                  </div>
                ))}
              </div>
              
              {/* Dataset expansion preview */}
              <div className="mt-6 p-4 rounded-xl bg-gradient-to-r from-green-500/10 to-blue-500/10 border border-green-500/20">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-sm text-white/60">Dataset Expansion</div>
                    <div className="text-2xl font-bold">
                      1,247 → <span className="text-green-400">{1247 * (augConfig.copiesPerImage + 1)}</span> images
                    </div>
                  </div>
                  <div>
                    <label className="text-sm text-white/60 block mb-1">Copies per image</label>
                    <select 
                      value={augConfig.copiesPerImage}
                      onChange={(e) => setAugConfig({...augConfig, copiesPerImage: parseInt(e.target.value)})}
                      className="bg-white/10 border border-white/20 rounded-lg px-3 py-2"
                    >
                      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => (
                        <option key={n} value={n}>{n}x</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Results Tab */}
        {activeTab === 'results' && (
          <div className="space-y-6">
            {/* Summary Cards */}
            <div className="grid grid-cols-5 gap-4">
              {[
                { label: 'mAP50', value: '91.2%', color: 'green', icon: '🎯' },
                { label: 'mAP50-95', value: '68.7%', color: 'blue', icon: '📊' },
                { label: 'Precision', value: '90.3%', color: 'purple', icon: '✅' },
                { label: 'Recall', value: '89.1%', color: 'orange', icon: '🔍' },
                { label: 'F1 Score', value: '89.7%', color: 'pink', icon: '⚖️' },
              ].map((metric, i) => (
                <div key={i} className="metric-card rounded-2xl p-5">
                  <div className="text-2xl mb-2">{metric.icon}</div>
                  <div className={`text-3xl font-bold text-${metric.color}-400`}>{metric.value}</div>
                  <div className="text-white/50 text-sm mt-1">{metric.label}</div>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-6">
              {/* Radar Chart */}
              <div className="glass rounded-2xl p-6">
                <div className="text-lg font-semibold mb-4 font-['Space_Grotesk',sans-serif]">Performance Overview</div>
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <RadarChart data={radarData}>
                      <PolarGrid stroke="rgba(255,255,255,0.1)" />
                      <PolarAngleAxis dataKey="metric" stroke="rgba(255,255,255,0.5)" fontSize={12} />
                      <PolarRadiusAxis angle={30} domain={[0, 1]} stroke="rgba(255,255,255,0.3)" />
                      <Radar
                        name="Model"
                        dataKey="value"
                        stroke="#22c55e"
                        fill="#22c55e"
                        fillOpacity={0.3}
                        strokeWidth={2}
                      />
                    </RadarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Per-Class Performance */}
              <div className="glass rounded-2xl p-6">
                <div className="text-lg font-semibold mb-4 font-['Space_Grotesk',sans-serif]">Per-Class Performance</div>
                <div className="h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={classPerformance} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                      <XAxis type="number" domain={[0, 1]} stroke="rgba(255,255,255,0.3)" fontSize={10} />
                      <YAxis dataKey="class" type="category" stroke="rgba(255,255,255,0.3)" fontSize={11} width={100} />
                      <Tooltip 
                        contentStyle={{ 
                          background: 'rgba(10, 15, 26, 0.9)', 
                          border: '1px solid rgba(255,255,255,0.1)',
                          borderRadius: '8px'
                        }}
                      />
                      <Bar dataKey="precision" fill="#22c55e" name="Precision" radius={[0, 4, 4, 0]} />
                      <Bar dataKey="recall" fill="#3b82f6" name="Recall" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* Confusion Matrix */}
            <div className="glass rounded-2xl p-6">
              <div className="text-lg font-semibold mb-4 font-['Space_Grotesk',sans-serif]">Confusion Matrix</div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="p-3 text-left text-white/40 text-sm">Actual ↓ / Predicted →</th>
                      {['Wattle', 'Lantana', 'Bellyache', 'Background'].map(label => (
                        <th key={label} className="p-3 text-center text-white/60 text-sm">{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {confusionData.map((row, i) => (
                      <tr key={i}>
                        <td className="p-3 text-white/60 text-sm font-medium">{row.actual}</td>
                        {['Wattle', 'Lantana', 'Bellyache', 'Background'].map((col, j) => {
                          const value = row[col];
                          const isCorrect = row.actual === col;
                          const intensity = isCorrect ? Math.min(value / 150, 1) : Math.min(value / 20, 1);
                          return (
                            <td key={j} className="p-1">
                              <div 
                                className={`p-3 rounded-lg text-center font-mono text-sm ${
                                  isCorrect 
                                    ? 'bg-green-500' 
                                    : value > 0 ? 'bg-red-500' : 'bg-white/5'
                                }`}
                                style={{ opacity: isCorrect ? 0.3 + intensity * 0.7 : value > 0 ? 0.2 + intensity * 0.6 : 0.3 }}
                              >
                                {value}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Export Section */}
            <div className="glass rounded-2xl p-6">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-lg font-semibold font-['Space_Grotesk',sans-serif]">Export Model</div>
                  <div className="text-white/50 text-sm mt-1">Download trained weights and metrics</div>
                </div>
                <div className="flex gap-3">
                  <button className="px-5 py-2.5 rounded-xl bg-white/10 border border-white/20 hover:bg-white/20 transition-all text-sm">
                    📄 Export Metrics (JSON)
                  </button>
                  <button className="px-5 py-2.5 rounded-xl bg-white/10 border border-white/20 hover:bg-white/20 transition-all text-sm">
                    📊 Download Report (PDF)
                  </button>
                  <button className="train-btn px-5 py-2.5 rounded-xl font-semibold text-sm">
                    ⬇️ Download Model (best.pt)
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Model Registry Tab */}
        {activeTab === 'models' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold font-['Space_Grotesk',sans-serif]">Trained Models</h2>
                <p className="text-white/50 text-sm">Manage and deploy your detection models</p>
              </div>
              <button className="train-btn px-5 py-2.5 rounded-xl font-semibold text-sm">
                + Train New Model
              </button>
            </div>

            {/* Model Cards */}
            <div className="grid grid-cols-1 gap-4">
              {[
                { name: 'wattle-detector', version: 'v3', mAP: 91.2, status: 'active', date: '2025-01-06', size: '42.3 MB', epochs: 100 },
                { name: 'lantana-detector', version: 'v2', mAP: 87.8, status: 'ready', date: '2025-01-04', size: '42.1 MB', epochs: 80 },
                { name: 'multi-weed', version: 'v1', mAP: 84.5, status: 'ready', date: '2024-12-28', size: '43.7 MB', epochs: 150 },
                { name: 'wattle-detector', version: 'v2', mAP: 88.3, status: 'archived', date: '2024-12-15', size: '42.0 MB', epochs: 100 },
              ].map((model, i) => (
                <div key={i} className={`glass rounded-2xl p-5 ${model.status === 'active' ? 'border-green-500/50 border' : ''}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-green-500/20 to-blue-500/20 flex items-center justify-center text-2xl">
                        🤖
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">{model.name}</span>
                          <span className="px-2 py-0.5 rounded bg-white/10 text-xs">{model.version}</span>
                          {model.status === 'active' && (
                            <span className="px-2 py-0.5 rounded bg-green-500/20 text-green-400 text-xs flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                              Active
                            </span>
                          )}
                          {model.status === 'archived' && (
                            <span className="px-2 py-0.5 rounded bg-white/10 text-white/40 text-xs">Archived</span>
                          )}
                        </div>
                        <div className="text-white/50 text-sm mt-1">
                          Trained {model.date} • {model.epochs} epochs • {model.size}
                        </div>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-6">
                      <div className="text-center">
                        <div className="text-2xl font-bold text-green-400">{model.mAP}%</div>
                        <div className="text-xs text-white/40">mAP50</div>
                      </div>
                      
                      <div className="flex gap-2">
                        {model.status !== 'active' && model.status !== 'archived' && (
                          <button className="px-4 py-2 rounded-lg bg-green-500/20 text-green-400 text-sm hover:bg-green-500/30 transition-all">
                            Deploy
                          </button>
                        )}
                        <button className="px-4 py-2 rounded-lg bg-white/10 text-white/70 text-sm hover:bg-white/20 transition-all">
                          Download
                        </button>
                        <button className="px-4 py-2 rounded-lg bg-white/10 text-white/70 text-sm hover:bg-white/20 transition-all">
                          Compare
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Comparison Chart */}
            <div className="glass rounded-2xl p-6">
              <div className="text-lg font-semibold mb-4 font-['Space_Grotesk',sans-serif]">Model Comparison</div>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={[
                    { name: 'wattle-v3', mAP50: 91.2, mAP5095: 68.7, precision: 90.3 },
                    { name: 'wattle-v2', mAP50: 88.3, mAP5095: 64.2, precision: 87.1 },
                    { name: 'lantana-v2', mAP50: 87.8, mAP5095: 62.9, precision: 86.5 },
                    { name: 'multi-weed-v1', mAP50: 84.5, mAP5095: 58.3, precision: 83.2 },
                  ]}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" />
                    <XAxis dataKey="name" stroke="rgba(255,255,255,0.3)" fontSize={11} />
                    <YAxis stroke="rgba(255,255,255,0.3)" fontSize={10} domain={[0, 100]} />
                    <Tooltip 
                      contentStyle={{ 
                        background: 'rgba(10, 15, 26, 0.9)', 
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '8px'
                      }}
                    />
                    <Bar dataKey="mAP50" fill="#22c55e" name="mAP50" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="mAP5095" fill="#3b82f6" name="mAP50-95" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="precision" fill="#a855f7" name="Precision" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
