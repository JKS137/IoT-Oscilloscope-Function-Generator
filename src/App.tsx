/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI } from "@google/genai";
import React, { useState, useEffect, useRef } from 'react';
import { 
  Activity, 
  Settings2, 
  Download, 
  Zap, 
  Waves, 
  AlertCircle,
  Menu,
  X,
  Play,
  Square,
  RefreshCw,
  Sparkles,
  Loader2,
  LogIn,
  LogOut,
  Save,
  User as UserIcon
} from 'lucide-react';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  ResponsiveContainer, 
  ReferenceLine 
} from 'recharts';
import { motion, AnimatePresence } from 'motion/react';
import socket from './lib/socket';
import { auth, db, loginWithGoogle, logout, handleFirestoreError, OperationType } from './lib/firebase';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';
import { doc, setDoc, collection, addDoc, getDoc } from 'firebase/firestore';
import { GeneratorSettings, SignalPoint, WaveformType } from './types';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function App() {
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [points, setPoints] = useState<SignalPoint[]>([]);
  const [settings, setSettings] = useState<GeneratorSettings>({
    type: 'sine',
    frequency: 10,
    amplitude: 2.5,
    offset: 2.5
  });
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isAutoScaling, setIsAutoScaling] = useState(true);
  const [isAiAnalyzing, setIsAiAnalyzing] = useState(false);
  const [isLive, setIsLive] = useState(true);
  const [alerts, setAlerts] = useState<{ id: string, msg: string, time: string }[]>([]);
  const [aiReport, setAiReport] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setIsAuthLoading(false);
      
      if (u) {
        // Ensure user doc exists
        try {
          const userRef = doc(db, 'users', u.uid);
          const userSnap = await getDoc(userRef);
          if (!userSnap.exists()) {
             await setDoc(userRef, {
               uid: u.uid,
               email: u.email,
               displayName: u.displayName,
               createdAt: new Date().toISOString(),
               role: 'user'
             });
          }
        } catch (error) {
           console.error("User sync error", error);
        }
      }
    });
    return () => unsubscribe();
  }, []);

  const saveWaveform = async () => {
    if (!user) {
      alert("Please login to save waveforms");
      return;
    }
    if (points.length === 0) return;

    setIsSaving(true);
    try {
      const data = {
        uid: user.uid,
        name: `Capture ${new Date().toLocaleString()}`,
        settings,
        points: points.slice(-100), // Only save a snapshot of 100 points
        createdAt: new Date().toISOString()
      };
      await addDoc(collection(db, 'waveforms'), data);
      
      const newAlert = {
        id: Math.random().toString(36).substr(2, 9),
        msg: "Waveform saved successfully!",
        time: new Date().toLocaleTimeString()
      };
      setAlerts(prev => [newAlert, ...prev]);
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'waveforms');
    } finally {
      setIsSaving(false);
    }
  };

  const performAiAnalysis = async () => {
    setIsAiAnalyzing(true);
    setAiReport(null);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      // Sampling some points for context
      const samplePoints = points.filter((_, i) => i % 5 === 0);
      const dataStr = samplePoints.map(p => `t:${p.t}, v:${p.v}`).join('\n');
      
      const prompt = `
        You are an expert electronics engineer and signal analyst.
        Analyze the following signal data from an IoT-connected oscilloscope.
        The equipment is simulating a ${settings.type} wave at ${settings.frequency}Hz.
        
        Signal Data (subset):
        ${dataStr}
        
        Provide a concise analysis:
        1. Does the waveform match the expected ${settings.type} pattern?
        2. Identify any visible noise or clipping.
        3. Suggest what this signal could represent in a real-world scenario (e.g., sensor data, power line, etc.).
        4. Check for anomalies.
      `;

      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-lite-preview",
        contents: prompt,
      });

      setAiReport(response.text || "No analysis generated.");
    } catch (error) {
      console.error("AI Analysis failed:", error);
      setAiReport("Failed to analyze signal. Check console for details.");
    } finally {
      setIsAiAnalyzing(false);
    }
  };
  
  const pointsRef = useRef<SignalPoint[]>([]);
  const maxPoints = 300; // Limit for performance

  useEffect(() => {
    socket.on('settings-sync', (newSettings: GeneratorSettings) => {
      setSettings(newSettings);
    });

    socket.on('signal-batch', (batch: SignalPoint[]) => {
      if (!isLive) return;
      
      const latestPoints = [...pointsRef.current, ...batch].slice(-maxPoints);
      pointsRef.current = latestPoints;
      setPoints(latestPoints);

      // Check for voltage spikes
      const maxInBatch = Math.max(...batch.map(p => p.v));
      if (maxInBatch > 4.8) {
        const newAlert = {
          id: Math.random().toString(36).substr(2, 9),
          msg: `Voltage spike detected: ${maxInBatch.toFixed(2)}V`,
          time: new Date().toLocaleTimeString()
        };
        setAlerts(prev => [newAlert, ...prev].slice(0, 5));
      }
    });

    return () => {
      socket.off('settings-sync');
      socket.off('signal-batch');
    };
  }, [isLive]);

  const updateSettings = (updates: Partial<GeneratorSettings>) => {
    const next = { ...settings, ...updates };
    setSettings(next);
    socket.emit('update-settings', next);
  };

  const exportAsCSV = () => {
    const csvContent = [
      ['Time (s)', 'Voltage (V)'],
      ...points.map(p => [p.t, p.v])
    ].map(e => e.join(',')).join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', `waveform_${new Date().toISOString()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Calculate stats
  const vMax = points.length ? Math.max(...points.map(p => p.v)) : 0;
  const vMin = points.length ? Math.min(...points.map(p => p.v)) : 0;
  const vAvg = points.length ? (points.reduce((acc, p) => acc + p.v, 0) / points.length) : 0;
  const vPp = vMax - vMin;

  return (
    <div className="flex h-screen bg-zinc-950 overflow-hidden text-zinc-300 font-sans">
      {/* Mobile Header */}
      <div className="lg:hidden fixed top-0 left-0 right-0 h-16 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between px-4 z-50">
        <div className="flex items-center gap-2">
          <Activity className="text-emerald-500" size={24} />
          <span className="font-bold tracking-tight text-white">IoT SCOPE</span>
        </div>
        <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="p-2 hover:bg-zinc-800 rounded-md">
          {isSidebarOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>

      {/* Sidebar / Controls */}
      <AnimatePresence>
        {isSidebarOpen && (
          <motion.aside
            initial={{ x: -300 }}
            animate={{ x: 0 }}
            exit={{ x: -300 }}
            className="fixed inset-y-0 left-0 lg:static lg:w-80 bg-zinc-900 border-r border-zinc-800 z-40 overflow-y-auto pt-16 lg:pt-0"
          >
            <div className="p-6 space-y-8">
              <div className="hidden lg:flex items-center gap-2 mb-8">
                <Activity className="text-emerald-500" size={24} />
                <span className="font-bold tracking-tight text-white text-xl text-nowrap">IoT SCOPE</span>
              </div>

              {/* Waveform Selector */}
              <section>
                <div className="flex items-center gap-2 mb-4">
                  <Waves size={16} className="text-emerald-400" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Waveform Type</h3>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {(['sine', 'square', 'triangle', 'sawtooth'] as WaveformType[]).map((type) => (
                    <button
                      key={type}
                      onClick={() => updateSettings({ type })}
                      className={cn(
                        "px-3 py-2 rounded-md border text-sm capitalize transition-all",
                        settings.type === type 
                          ? "bg-emerald-500/10 border-emerald-500 text-emerald-400" 
                          : "bg-zinc-800 border-zinc-700 hover:border-zinc-500"
                      )}
                    >
                      {type}
                    </button>
                  ))}
                </div>
              </section>

              {/* Parameters */}
              <section className="space-y-6">
                <div className="flex items-center gap-2 mb-4">
                  <Settings2 size={16} className="text-blue-400" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Parameters</h3>
                </div>
                
                <ControlSlider 
                  label="Frequency" 
                  unit="Hz" 
                  value={settings.frequency} 
                  min={1} 
                  max={200} 
                  onChange={(v) => updateSettings({ frequency: v })} 
                />
                <ControlSlider 
                  label="Amplitude" 
                  unit="V" 
                  value={settings.amplitude} 
                  min={0.1} 
                  max={2.5} 
                  step={0.1}
                  onChange={(v) => updateSettings({ amplitude: v })} 
                />
                <ControlSlider 
                  label="Offset" 
                  unit="V" 
                  value={settings.offset} 
                  min={0} 
                  max={5} 
                  step={0.1}
                  onChange={(v) => updateSettings({ offset: v })} 
                />
              </section>

              {/* Display Options */}
              <section className="space-y-4">
                 <div className="flex items-center gap-2 mb-4">
                  <Zap size={16} className="text-amber-400" />
                  <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500">Display</h3>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Auto-scale Y</span>
                  <Switch checked={isAutoScaling} onChange={setIsAutoScaling} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Real-time Feed</span>
                  <button 
                    onClick={() => setIsLive(!isLive)}
                    className={cn(
                      "p-1 rounded-full transition-colors",
                      isLive ? "text-emerald-500" : "text-zinc-500"
                    )}
                  >
                    {isLive ? <RefreshCw size={20} className="animate-spin" /> : <RefreshCw size={20} />}
                  </button>
                </div>
              </section>

              {/* Actions */}
              <section className="pt-4 space-y-2">
                <button 
                  onClick={performAiAnalysis}
                  disabled={isAiAnalyzing}
                  className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 transition-colors py-2 rounded-md text-sm font-bold text-white shadow-[0_0_15px_rgba(16,185,129,0.3)]"
                >
                  {isAiAnalyzing ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
                  AI Analyze Trace
                </button>
                <button 
                  onClick={saveWaveform}
                  disabled={isSaving || !user}
                  className="w-full flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 transition-colors py-2 rounded-md text-sm border border-zinc-700"
                >
                  {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} 
                  Save Capture
                </button>
                <button 
                  onClick={exportAsCSV}
                  className="w-full flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 transition-colors py-2 rounded-md text-sm border border-zinc-700"
                >
                  <Download size={16} /> Export CSV
                </button>
              </section>

              {/* AI Report Section */}
              <AnimatePresence>
                {aiReport && (
                  <motion.section
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="p-4 bg-emerald-500/5 border border-emerald-500/20 rounded-lg space-y-2">
                      <div className="flex items-center justify-between">
                        <h4 className="text-[10px] font-bold uppercase tracking-wider text-emerald-500">AI Signal Report</h4>
                        <button onClick={() => setAiReport(null)}><X size={12} className="text-zinc-500" /></button>
                      </div>
                      <p className="text-[11px] leading-relaxed text-zinc-400 italic">
                        {aiReport}
                      </p>
                    </div>
                  </motion.section>
                )}
              </AnimatePresence>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 bg-black">
        {/* Toolbar */}
        <header className="h-16 border-b border-zinc-800 flex items-center justify-between px-6 bg-zinc-900/50 backdrop-blur-sm hidden lg:flex">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs font-mono uppercase text-emerald-500">Device Connected</span>
            </div>
            <div className="h-4 w-[1px] bg-zinc-800" />
            <span className="text-xs font-mono text-zinc-500">SIMULATED RP4 NODE</span>
          </div>
          
          <div className="flex items-center gap-3">
             {user ? (
               <div className="flex items-center gap-4">
                 <div className="flex items-center gap-2 bg-zinc-800 px-3 py-1.5 rounded-full border border-zinc-700">
                    {user.photoURL ? (
                      <img src={user.photoURL} alt="User" className="w-5 h-5 rounded-full" referrerPolicy="no-referrer" />
                    ) : (
                      <UserIcon size={14} className="text-zinc-400" />
                    )}
                    <span className="text-xs font-medium text-zinc-300">{user.displayName || user.email}</span>
                 </div>
                 <button 
                  onClick={logout}
                  className="p-2 hover:bg-zinc-800 rounded-md text-zinc-400 hover:text-white transition-colors"
                  title="Logout"
                >
                  <LogOut size={18} />
                </button>
               </div>
             ) : (
               <button 
                onClick={loginWithGoogle}
                disabled={isAuthLoading}
                className="flex items-center gap-2 px-4 py-1.5 bg-zinc-100 text-zinc-950 rounded-md text-xs font-bold hover:bg-white transition-all disabled:opacity-50"
               >
                 <LogIn size={14} /> Login with Google
               </button>
             )}
             
             <div className="h-4 w-[1px] bg-zinc-800 mx-1" />

             <button 
              onClick={() => setIsLive(!isLive)}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium transition-all border",
                isLive 
                  ? "bg-red-500/10 border-red-500 text-red-400" 
                  : "bg-emerald-500/10 border-emerald-500 text-emerald-400"
              )}
            >
              {isLive ? <><Square size={14} /> STOP</> : <><Play size={14} /> RESUME</>}
            </button>
          </div>
        </header>

        {/* Dashboard Content */}
        <div className="flex-1 overflow-y-auto p-4 lg:p-8 space-y-6 pt-20 lg:pt-8">
          
          {/* Main Oscilloscope Card */}
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            <div className="lg:col-span-3 bg-zinc-900/40 border border-zinc-800 rounded-xl p-6 relative overflow-hidden group">
              <div className="absolute top-0 left-0 w-1 h-full bg-emerald-500 opacity-50" />
              <div className="flex items-center justify-between mb-8">
                <h2 className="text-sm font-bold uppercase tracking-widest text-zinc-400 flex items-center gap-2">
                  <Activity size={18} className="text-emerald-500" />
                  Live Trace
                </h2>
                <div className="flex gap-4 text-xs font-mono">
                   <div className="flex flex-col">
                    <span className="text-zinc-500 text-[10px] uppercase">Sampling</span>
                    <span className="text-zinc-100">500 Sa/s</span>
                  </div>
                   <div className="flex flex-col">
                    <span className="text-zinc-500 text-[10px] uppercase">Resolution</span>
                    <span className="text-zinc-100">12-bit</span>
                  </div>
                </div>
              </div>

              {/* Chart Container */}
              <div className="h-[400px] w-full oscilloscope-grid">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={points} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={true} />
                    <XAxis 
                      dataKey="t" 
                      type="number" 
                      domain={['auto', 'auto']} 
                      hide
                    />
                    <YAxis 
                      type="number" 
                      domain={isAutoScaling ? ['auto', 'auto'] : [0, 5]}
                      ticks={[0, 1, 2, 3, 4, 5]}
                    />
                    <ReferenceLine y={2.5} stroke="#525252" strokeDasharray="3 3" />
                    <Line 
                      type="monotone" 
                      dataKey="v" 
                      stroke="#10b981" 
                      strokeWidth={2} 
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Sidebar Stats */}
            <div className="space-y-4">
              <StatCard label="V peak-peak" value={vPp.toFixed(2)} unit="V" icon={<Zap className="text-amber-400" size={16} />} />
              <StatCard label="V average" value={vAvg.toFixed(2)} unit="V" icon={<Activity className="text-blue-400" size={16} />} />
              <StatCard label="V max" value={vMax.toFixed(2)} unit="V" className="border-emerald-500/20" />
              <StatCard label="V min" value={vMin.toFixed(2)} unit="V" className="border-red-500/20" />
            </div>
          </div>

          {/* Device Logs / Alerts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-6">
              <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500 mb-4 flex items-center gap-2">
                <AlertCircle size={16} className="text-amber-500" />
                Connectivity Status
              </h3>
              <div className="space-y-3">
                 <div className="flex items-center justify-between text-sm py-2 border-b border-zinc-800">
                  <span className="text-zinc-400">Node Status</span>
                  <span className="text-emerald-400 flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_#10b981]" /> ONLINE</span>
                </div>
                 <div className="flex items-center justify-between text-sm py-2 border-b border-zinc-800">
                  <span className="text-zinc-400">Latency</span>
                  <span className="text-zinc-100 font-mono">14ms</span>
                </div>
                 <div className="flex items-center justify-between text-sm py-2">
                  <span className="text-zinc-400">Uptime</span>
                  <span className="text-zinc-100 font-mono">12h 43m</span>
                </div>
              </div>
            </div>

            <div className="bg-zinc-900/40 border border-zinc-800 rounded-xl p-6 relative overflow-hidden">
               <div className="absolute top-0 right-0 p-3">
                <Waves className="text-zinc-800" size={48} />
               </div>
               <h3 className="text-xs font-bold uppercase tracking-widest text-zinc-500 mb-4">Signal Metadata</h3>
               <div className="grid grid-cols-2 gap-4">
                  <div className="p-3 bg-zinc-950/50 rounded-lg border border-zinc-800">
                    <span className="block text-[10px] uppercase text-zinc-500 mb-1">Frequency</span>
                    <span className="text-lg font-mono text-zinc-100">{settings.frequency} Hz</span>
                  </div>
                  <div className="p-3 bg-zinc-950/50 rounded-lg border border-zinc-800">
                    <span className="block text-[10px] uppercase text-zinc-500 mb-1">Load Status</span>
                    <span className="text-lg font-mono text-emerald-400">NOMINAL</span>
                  </div>
               </div>
            </div>
          </div>
        </div>
      </main>

      {/* Floating Alerts */}
      <div className="fixed bottom-6 right-6 z-50 space-y-2 pointer-events-none">
        <AnimatePresence>
          {alerts.map((alert) => (
            <motion.div
              key={alert.id}
              initial={{ x: 100, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 100, opacity: 0 }}
              className="bg-red-500 text-white px-4 py-3 rounded-lg shadow-xl flex items-center gap-3 pointer-events-auto min-w-[280px]"
            >
              <AlertCircle size={20} />
              <div>
                <p className="text-sm font-bold">{alert.msg}</p>
                <p className="text-[10px] opacity-80">{alert.time}</p>
              </div>
              <button onClick={() => setAlerts(prev => prev.filter(a => a.id !== alert.id))} className="ml-auto hover:bg-black/10 p-1 rounded">
                <X size={14} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

// Subcomponents

function ControlSlider({ label, value, min, max, unit, step = 1, onChange }: { 
  label: string, value: number, min: number, max: number, unit: string, step?: number, onChange: (v: number) => void 
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="text-zinc-400 uppercase tracking-wide">{label}</span>
        <span className="font-mono text-zinc-100">{value.toFixed(step < 1 ? 1 : 0)}{unit}</span>
      </div>
      <input 
        type="range" 
        min={min} 
        max={max} 
        step={step}
        value={value} 
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
      />
    </div>
  );
}

function StatCard({ label, value, unit, icon, className }: { label: string, value: string, unit: string, icon?: React.ReactNode, className?: string }) {
  return (
    <div className={cn("bg-zinc-900/60 border border-zinc-800 p-4 rounded-xl flex items-center justify-between", className)}>
      <div>
        <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mb-1">{label}</p>
        <div className="flex items-end gap-1">
          <span className="text-xl font-mono text-zinc-100 leading-none">{value}</span>
          <span className="text-[10px] font-medium text-zinc-500 pb-0.5">{unit}</span>
        </div>
      </div>
      {icon}
    </div>
  );
}

function Switch({ checked, onChange }: { checked: boolean, onChange: (v: boolean) => void }) {
  return (
    <button 
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-10 items-center rounded-full transition-colors focus:outline-none",
        checked ? "bg-emerald-500" : "bg-zinc-700"
      )}
    >
      <span
        className={cn(
          "inline-block h-3 w-3 transform rounded-full bg-white transition-transform",
          checked ? "translate-x-6" : "translate-x-1"
        )}
      />
    </button>
  );
}
