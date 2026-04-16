/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, Type } from "@google/genai";
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
  ReferenceLine,
  ReferenceArea,
  Tooltip
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
  const [aiFindings, setAiFindings] = useState<{ xStart: number, xEnd: number, label: string, details: string, color: string }[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  
  // Zoom & Pan State
  const [viewDomainX, setViewDomainX] = useState<[number, number] | null>(null);
  const [viewDomainY, setViewDomainY] = useState<[number, number] | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const lastMousePos = useRef<{ x: number, y: number } | null>(null);

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
    setAiFindings([]);
    // Pause live feed to visualize static findings
    setIsLive(false);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      // Sampling points for context
      const samplePoints = points.filter((_, i) => i % 5 === 0);
      const dataStr = samplePoints.map(p => `t:${p.t.toFixed(4)}, v:${p.v.toFixed(3)}`).join('\n');
      
      const prompt = `
        You are an expert electronics engineer and signal analyst.
        Analyze the following signal data from an IoT-connected oscilloscope.
        The equipment is simulating a ${settings.type} wave at ${settings.frequency}Hz.
        
        Signal Data (subset):
        ${dataStr}
        
        Provide a detailed report and identify specific regions of interest (e.g., clipping, noise, transients, dc-offset issues).
        If a region is identified, pinpoint the start and end 't' values.
        For each finding, provide a meaningful 'label' and a detailed technical explanation under 'details'.
      `;

      const response = await ai.models.generateContent({
        model: "gemini-3.1-flash-lite-preview",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              analysisText: { type: Type.STRING, description: "The descriptive analysis of the signal." },
              findings: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    xStart: { type: Type.NUMBER, description: "Start time 't' value" },
                    xEnd: { type: Type.NUMBER, description: "End time 't' value" },
                    label: { type: Type.STRING, description: "Brief label for the finding (e.g., 'Clipping')" },
                    details: { type: Type.STRING, description: "Deep technical detail about why this was flagged." },
                    color: { type: Type.STRING, description: "CSS color hex for highlight (e.g., '#ff4444' for clipping, '#ffbb33' for noise)" }
                  },
                  required: ["xStart", "xEnd", "label", "details", "color"]
                }
              }
            },
            required: ["analysisText", "findings"]
          }
        }
      });

      const result = JSON.parse(response.text);
      setAiReport(result.analysisText);
      setAiFindings(result.findings || []);
    } catch (error) {
      console.error("AI Analysis failed:", error);
      setAiReport("Failed to analyze signal. Check console for details.");
    } finally {
      setIsAiAnalyzing(false);
    }
  };
  
  const saveSettings = async () => {
    if (!user) {
      alert("Please login to save settings");
      return;
    }
    setIsSavingSettings(true);
    try {
      const userRef = doc(db, 'users', user.uid);
      await setDoc(userRef, {
        savedSettings: settings,
        updatedAt: new Date().toISOString()
      }, { merge: true });

      const newAlert = {
        id: Math.random().toString(36).substr(2, 9),
        msg: "Generator settings saved to profile!",
        time: new Date().toLocaleTimeString()
      };
      setAlerts(prev => [newAlert, ...prev]);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `users/${user.uid}`);
    } finally {
      setIsSavingSettings(false);
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
  const resetView = () => {
    setViewDomainX(null);
    setViewDomainY(null);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (!points.length) return;

    const zoomStep = 0.1;
    const direction = e.deltaY > 0 ? 1 : -1;
    const factor = 1 + direction * zoomStep;

    // Current domains
    const minX = viewDomainX ? viewDomainX[0] : Math.min(...points.map(p => p.t));
    const maxX = viewDomainX ? viewDomainX[1] : Math.max(...points.map(p => p.t));
    const minY = viewDomainY ? viewDomainY[0] : Math.min(...points.map(p => p.v));
    const maxY = viewDomainY ? viewDomainY[1] : Math.max(...points.map(p => p.v));

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const rangeX = (maxX - minX) * factor;
    const rangeY = (maxY - minY) * factor;

    setViewDomainX([centerX - rangeX / 2, centerX + rangeX / 2]);
    setViewDomainY([centerY - rangeY / 2, centerY + rangeY / 2]);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    isDragging.current = true;
    lastMousePos.current = { x: e.clientX, y: e.clientY };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging.current || !lastMousePos.current || !points.length) return;

    const dx = e.clientX - lastMousePos.current.x;
    const dy = e.clientY - lastMousePos.current.y;
    lastMousePos.current = { x: e.clientX, y: e.clientY };

    // Approximation of scale - in a real app we'd map pixels to data units
    // using chart container dimensions, but for UX this feels responsive:
    const minX = viewDomainX ? viewDomainX[0] : Math.min(...points.map(p => p.t));
    const maxX = viewDomainX ? viewDomainX[1] : Math.max(...points.map(p => p.t));
    const minY = viewDomainY ? viewDomainY[0] : Math.min(...points.map(p => p.v));
    const maxY = viewDomainY ? viewDomainY[1] : Math.max(...points.map(p => p.v));

    const scaleX = (maxX - minX) / 800; // rough width
    const scaleY = (maxY - minY) / 400; // rough height

    const shiftX = dx * scaleX;
    const shiftY = dy * scaleY;

    setViewDomainX([minX - shiftX, maxX - shiftX]);
    setViewDomainY([minY + shiftY, maxY + shiftY]);
  };

  const handleMouseUp = () => {
    isDragging.current = false;
  };

  const vMax = points.length ? Math.max(...points.map(p => p.v)) : 0;
  const vMin = points.length ? Math.min(...points.map(p => p.v)) : 0;
  const vAvg = points.length ? (points.reduce((acc, p) => acc + p.v, 0) / points.length) : 0;
  const vPp = vMax - vMin;

  return (
    <div className="grid lg:grid-cols-[1fr_280px] lg:grid-rows-[60px_1fr_220px] h-screen bg-bg-main p-3 gap-3 overflow-hidden text-text-primary font-sans">
      
      {/* Mobile Menu Toggle */}
      <motion.button 
        whileHover={{ scale: 1.1 }}
        whileTap={{ scale: 0.9 }}
        onClick={() => setIsSidebarOpen(!isSidebarOpen)} 
        className="lg:hidden fixed top-4 right-4 z-[60] bg-panel p-2 rounded-full border border-border-main"
      >
        {isSidebarOpen ? <X size={20} /> : <Menu size={20} />}
      </motion.button>

      {/* Header */}
      <header className="col-span-full h-full bg-panel border border-border-main rounded-lg flex items-center justify-between px-6">
        <div className="flex items-center gap-3">
          <Activity className="text-accent-green glow-green" size={24} />
          <span className="font-bold tracking-widest text-text-primary text-sm uppercase">IOT.NEXUS / OSCILLOSCOPE</span>
        </div>
        
        <div className="hidden lg:flex items-center gap-8 text-[11px] font-mono text-text-muted">
          <div className="flex items-center gap-2">
            <div className="status-dot-active" />
            <span className="text-accent-green">CONNECTED: RP4-NODE-01</span>
          </div>
          <div className="flex items-center gap-2">
            <span>UPTIME: 12h 44m</span>
          </div>
          <div className="flex items-center gap-2">
             <span className="text-accent-blue">SAMPLE RATE: 1.0 MS/s</span>
          </div>
          <div className="flex items-center gap-4 ml-4">
             {user ? (
               <div className="flex items-center gap-3">
                  <span className="text-zinc-500">{user.displayName || user.email}</span>
                  <button onClick={logout} className="hover:text-white transition-colors">
                    <motion.div whileHover={{ rotate: 15 }} whileTap={{ scale: 0.8 }}>
                      <LogOut size={14} />
                    </motion.div>
                  </button>
               </div>
             ) : (
               <motion.button 
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={loginWithGoogle} 
                className="text-accent-blue hover:text-white transition-colors font-bold uppercase tracking-tighter"
               >
                 Login
               </motion.button>
             )}
          </div>
          <motion.button 
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => {
                  if (!isLive) setAiFindings([]);
                  setIsLive(!isLive);
                }}
                className={cn(
                  "flex items-center gap-2 px-3 py-1 rounded border text-[10px] font-bold uppercase transition-all",
                  isLive 
                    ? "bg-red-500/10 border-red-500 text-red-400" 
                    : "bg-accent-green/10 border-accent-green text-accent-green"
                )}
              >
                {isLive ? <Square size={12} /> : <Play size={12} />}
                {isLive ? 'Stop' : 'Run'}
          </motion.button>
        </div>
      </header>

      {/* Oscilloscope View */}
      <main 
        ref={chartRef}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        className="lg:col-start-1 lg:row-start-2 oscilloscope-view relative cursor-crosshair select-none"
      >
        <ResponsiveContainer width="100%" height="100%" className="immersive-grid">
          <LineChart data={points} margin={{ top: 20, right: 20, left: -20, bottom: 20 }}>
            <CartesianGrid strokeDasharray="0" />
            <XAxis 
              dataKey="t" 
              type="number" 
              hide={true}
              domain={viewDomainX || ['auto', 'auto']}
            />
            <YAxis 
              domain={viewDomainY || (isAutoScaling ? ['auto', 'auto'] : [-10, 10])} 
              tickCount={11}
            />

            <Tooltip 
              content={({ active, payload, label }) => {
                if (active && payload && payload.length && typeof label === 'number') {
                  const val = payload[0].value as number;
                  const finding = aiFindings.find(f => label >= f.xStart && label <= f.xEnd);
                  return (
                    <div className="bg-panel border border-border-main p-3 rounded-lg shadow-2xl backdrop-blur-md min-w-[200px]">
                      <div className="flex justify-between items-center mb-2">
                        <span className="text-[10px] font-mono text-text-muted">T: {label.toFixed(4)}s</span>
                        <span className="text-[10px] font-mono text-accent-blue">V: {val.toFixed(3)}V</span>
                      </div>
                      {finding && (
                        <motion.div 
                          initial={{ opacity: 0, y: 5 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="mt-2 pt-2 border-t border-border-main"
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: finding.color }} />
                            <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: finding.color }}>
                              {finding.label}
                            </span>
                          </div>
                          <p className="text-[10px] text-text-muted leading-relaxed italic">
                            {finding.details}
                          </p>
                        </motion.div>
                      )}
                    </div>
                  );
                }
                return null;
              }}
            />
            
            {/* AI Findings Visualization */}
            {aiFindings.map((finding, idx) => (
              <ReferenceArea
                key={idx}
                x1={finding.xStart}
                x2={finding.xEnd}
                fill={finding.color}
                fillOpacity={0.2}
                label={{ 
                  value: finding.label, 
                  position: 'insideTopLeft', 
                  fill: finding.color, 
                  fontSize: 10,
                  fontWeight: 'bold',
                  className: 'uppercase font-mono'
                }}
                stroke={finding.color}
                strokeDasharray="3 3"
              />
            ))}

            <Line
              type="monotone"
              dataKey="v"
              stroke="var(--color-accent-green)"
              strokeWidth={2.5}
              dot={false}
              isAnimationActive={false}
              className="glow-green"
            />
          </LineChart>
        </ResponsiveContainer>
        
        {/* Overlay Labels */}
        <div className="absolute top-4 left-6 text-[10px] font-mono text-accent-green/60 uppercase pointer-events-none">
          CH1: ACTIVE / {isAutoScaling ? 'AUTO' : '1.00V'} DIV
        </div>

        {/* Zoom Reset Button */}
        {(viewDomainX || viewDomainY) && (
          <motion.button
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            onClick={resetView}
            className="absolute bottom-4 right-6 bg-accent-blue/20 hover:bg-accent-blue/40 border border-accent-blue/50 text-accent-blue text-[9px] font-bold py-1 px-3 rounded-full uppercase tracking-widest backdrop-blur-md"
          >
            Reset View
          </motion.button>
        )}
      </main>

      {/* Sidebar */}
      <AnimatePresence>
        {isSidebarOpen && (
          <motion.aside
            initial={{ x: 300 }}
            animate={{ x: 0 }}
            exit={{ x: 300 }}
            className="fixed inset-y-3 right-3 w-80 lg:static lg:w-full lg:row-start-2 lg:row-end-4 flex flex-col gap-3 z-50 h-[calc(100vh-1.5rem)] lg:h-full"
          >
            {/* Live Measurements Card */}
            <div className="panel-card space-y-4">
              <h3 className="label-muted">Live Measurements</h3>
              <div className="space-y-3">
                <MetricRow label="Frequency" value={settings.frequency.toFixed(2)} unit="Hz" />
                <MetricRow label="Vpp" value={vPp.toFixed(2)} unit="V" />
                <MetricRow label="Vmax" value={vMax.toFixed(2)} unit="V" />
                <MetricRow label="Vmin" value={vMin.toFixed(2)} unit="V" />
                <MetricRow label="Vavg" value={vAvg.toFixed(2)} unit="V" />
              </div>
            </div>

            {/* Trigger / Settings Card */}
            <div className="panel-card space-y-4">
              <h3 className="label-muted">Trigger Settings</h3>
              <div className="bg-[#331111] text-red-500 text-[9px] font-mono font-bold px-2 py-0.5 rounded inline-block w-fit">
                AUTO ARM
              </div>
              <div className="grid grid-cols-2 gap-2 text-[11px]">
                 <div className="flex justify-between border-b border-border-main pb-1">
                   <span className="text-text-muted text-[10px] uppercase">Source</span>
                   <span className="text-accent-blue font-mono">CH1</span>
                 </div>
                 <div className="flex justify-between border-b border-border-main pb-1">
                   <span className="text-text-muted text-[10px] uppercase">Level</span>
                   <span className="text-accent-blue font-mono">0.5V</span>
                 </div>
                 <div className="flex justify-between border-b border-border-main pb-1">
                   <span className="text-text-muted text-[10px] uppercase">Auto-S</span>
                   <Switch checked={isAutoScaling} onChange={setIsAutoScaling} />
                 </div>
                 <div className="flex justify-between border-b border-border-main pb-1">
                   <span className="text-text-muted text-[10px] uppercase">Live</span>
                   <Switch 
                    checked={isLive} 
                    onChange={(v) => {
                      if (v) setAiFindings([]);
                      setIsLive(v);
                    }} 
                   />
                 </div>
              </div>
              
              <div className="pt-2">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={saveSettings}
                  disabled={isSavingSettings || !user}
                  className="w-full bg-accent-blue/10 border border-accent-blue/30 text-accent-blue text-[10px] font-bold py-2 rounded uppercase tracking-widest hover:bg-accent-blue/20 transition-all disabled:opacity-50"
                >
                  {isSavingSettings ? "Saving Settings..." : "Save Config to Profile"}
                </motion.button>
              </div>
            </div>

            {/* AI Analysis Section */}
            <div className="panel-card space-y-3 h-full flex flex-col min-h-0 overflow-hidden">
               <h3 className="label-muted">AI Intelligence</h3>
               <motion.button 
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={performAiAnalysis}
                  disabled={isAiAnalyzing}
                  className="w-full flex items-center justify-center gap-2 bg-accent-blue text-black font-bold uppercase py-2 rounded text-xs transition-opacity disabled:opacity-50"
               >
                 {isAiAnalyzing ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                 Run Analysis
               </motion.button>
               
               <div className="flex-1 overflow-y-auto pr-1">
                  {aiReport ? (
                    <div className="text-[11px] leading-relaxed text-text-muted italic bg-black/20 p-3 rounded border border-border-main">
                      {aiReport}
                    </div>
                  ) : (
                    <div className="h-full flex flex-center text-[10px] text-zinc-600 text-center items-center justify-center px-4">
                      Run AI Analysis to get insights on the current signal trace from Gemini.
                    </div>
                  )}
               </div>
            </div>

            {/* Export Card */}
            <div className="panel-card space-y-3">
               <h3 className="label-muted">Export Data</h3>
               <div className="grid grid-cols-2 gap-2">
                 <motion.button 
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={saveWaveform} 
                  disabled={isSaving || !user} 
                  className="bg-zinc-800 text-white text-[10px] py-1.5 rounded border border-border-main hover:bg-zinc-700 transition-colors uppercase font-bold flex items-center justify-center gap-1"
                 >
                   {isSaving ? "..." : <Save size={12} />} Save
                 </motion.button>
                 <motion.button 
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={exportAsCSV} 
                  className="bg-accent-green text-black text-[10px] py-1.5 rounded hover:opacity-90 transition-colors uppercase font-bold flex items-center justify-center gap-1"
                 >
                   <Download size={12} /> CSV
                 </motion.button>
               </div>
            </div>

            <div className="text-[9px] font-mono text-zinc-600 flex justify-between px-2">
              <span>IOT.NEXUS FRAMEWORK</span>
              <span>v2.1.0</span>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Controls Footer */}
      <footer className="lg:col-start-1 lg:row-start-3 bg-panel border border-border-main rounded-lg p-5 grid grid-cols-3 gap-6">
        
        {/* Waveform Select */}
        <div className="space-y-4">
          <h3 className="label-muted">Waveform Generator</h3>
          <div className="flex gap-1">
            {(['sine', 'square', 'triangle', 'sawtooth'] as WaveformType[]).map((type) => (
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                key={type}
                onClick={() => updateSettings({ type })}
                className={cn(
                  "flex-1 p-1.5 text-[9px] font-bold uppercase rounded border transition-all truncate",
                  settings.type === type 
                    ? "bg-accent-blue/10 border-accent-blue text-accent-blue" 
                    : "bg-[#222] border-border-main text-text-muted hover:border-zinc-500"
                )}
              >
                {type}
              </motion.button>
            ))}
          </div>
          <div className="flex justify-around items-center pt-2">
            <DialKnob label="Freq" value={(settings.frequency / 200) * 270} />
            <DialKnob label="Amp" value={(settings.amplitude / 2.5) * 270} />
            <DialKnob label="Offset" value={(settings.offset / 5) * 270} />
          </div>
        </div>

        {/* Time Parameters */}
        <div className="border-l border-border-main pl-6 space-y-6">
          <h3 className="label-muted">Horizontal (Time)</h3>
          <ControlSlider 
            label="Frequency" 
            unit="Hz" 
            value={settings.frequency} 
            min={1} 
            max={200} 
            onChange={(v) => updateSettings({ frequency: v })} 
          />
          <div className="text-[11px] font-mono text-text-muted text-center pt-2">
            TIMEBASE: 5.00 ms/DIV
          </div>
        </div>

        {/* Amplitude Parameters */}
        <div className="border-l border-border-main pl-6 space-y-6">
          <h3 className="label-muted">Vertical (Volts)</h3>
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
        </div>

      </footer>

      {/* Floating Alerts */}
      <div className="fixed bottom-6 right-6 z-[70] space-y-2 pointer-events-none">
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

function MetricRow({ label, value, unit }: { label: string, value: string, unit: string }) {
  return (
    <div className="flex justify-between items-baseline border-b border-border-main pb-1">
      <span className="text-[10px] text-text-muted uppercase tracking-tighter">{label}</span>
      <div className="flex items-baseline gap-1">
        <span className="metric-v">{value}</span>
        <span className="text-[9px] text-accent-blue/60 font-mono uppercase">{unit}</span>
      </div>
    </div>
  );
}

function DialKnob({ label, value }: { label: string, value: number }) {
  return (
    <motion.div 
      whileHover={{ scale: 1.1 }}
      className="flex flex-col items-center gap-1.5 cursor-pointer"
    >
      <div className="relative group">
        <motion.div 
          className="dial-knob"
          animate={{ rotate: value }}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
          style={{ '--rotation': `${value}deg` } as any}
        />
        <div className="absolute inset-0 bg-accent-blue/0 group-hover:bg-accent-blue/5 rounded-full transition-colors" />
      </div>
      <span className="text-[9px] font-bold uppercase text-text-muted">{label}</span>
    </motion.div>
  );
}

function ControlSlider({ label, value, min, max, unit, step = 1, onChange }: { 
  label: string, 
  value: number, 
  min: number, 
  max: number, 
  unit: string, 
  step?: number,
  onChange: (v: number) => void 
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[10px]">
        <span className="text-text-muted uppercase tracking-wide">{label}</span>
        <span className="font-mono text-accent-blue">{value.toFixed(step < 1 ? 1 : 0)}{unit}</span>
      </div>
      <input 
        type="range" 
        min={min} 
        max={max} 
        step={step}
        value={value} 
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1 bg-[#2a2a2a] rounded-full appearance-none cursor-pointer accent-accent-blue"
      />
    </div>
  );
}

function Switch({ checked, onChange }: { checked: boolean, onChange: (v: boolean) => void }) {
  return (
    <motion.button 
      whileTap={{ scale: 0.9 }}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-3.5 w-7 items-center rounded-full transition-colors focus:outline-none",
        checked ? "bg-accent-green glow-green" : "bg-zinc-800"
      )}
    >
      <motion.span
        animate={{ x: checked ? 16 : 4 }}
        transition={{ type: "spring", stiffness: 500, damping: 30 }}
        className="inline-block h-2 w-2 transform rounded-full bg-white"
      />
    </motion.button>
  );
}
