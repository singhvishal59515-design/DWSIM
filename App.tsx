import React, { useState, useRef, useEffect } from 'react';
import type { ChatMessage, UserMessage, AgentMessage, AgentStep } from './types';
import { runAgent } from './services/geminiService';
import { getPyodide, runPython } from './services/pyodide';
import { AgentIcon, DataAnalysisIcon, DWSIMIcon, FinalAnswerIcon, PythonIcon, SendIcon, UserIcon, PlayIcon, SearchIcon, ChartBarIcon, SitemapIcon, ErrorIcon, ImageIcon, CloseIcon } from './components/icons';

type PyodideStatus = 'loading' | 'ready' | 'error';

// --- Mock DWSIM Environment for Inspection ---
interface DWSIMProperty {
    value: number | string | string[] | null;
    unit?: string;
}

export interface DWSIMObject {
  name: string;
  type: 'Stream' | 'Heater' | 'DistillationColumn' | 'CSTR' | 'FlowsheetSettings' | 'Pump' | 'HeatExchanger' | 'Compressor';
  properties: { [key: string]: DWSIMProperty };
}

const mockSimulationState: DWSIMObject[] = [
  // --- Feed Section ---
  { 
    name: 'raw_feed', 
    type: 'Stream', 
    properties: { 
        Temperature: { value: 25, unit: 'C' }, 
        Pressure: { value: 1.2, unit: 'atm' }, 
        'Molar Flow': { value: 100, unit: 'kmol/h' }, 
        'Ethanol': { value: 0.4 },
        'Water': { value: 0.6 } 
    } 
  },
  {
    name: 'feed_pump',
    type: 'Pump',
    properties: {
      Inlet: { value: 'raw_feed' },
      Outlet: { value: 'pressurized_feed' },
      'Outlet Pressure': { value: 3, unit: 'atm' },
      Efficiency: { value: 0.8 }
    }
  },
  { 
    name: 'pressurized_feed', 
    type: 'Stream', 
    properties: { 
        Temperature: { value: 26, unit: 'C' }, // Slight temp increase from pump
        Pressure: { value: 3, unit: 'atm' }, 
        'Molar Flow': { value: 100, unit: 'kmol/h' }, 
    } 
  },
  {
    name: 'feed_preheater',
    type: 'HeatExchanger',
    properties: {
      'Hot Side Inlet': { value: 'bottoms' },
      'Hot Side Outlet': { value: 'cooled_bottoms' },
      'Cold Side Inlet': { value: 'pressurized_feed' },
      'Cold Side Outlet': { value: 'preheated_feed' },
      Duty: { value: 800, unit: 'kW' },
      'Overall Heat Transfer Coefficient': { value: 1500, unit: 'W/m^2.K' }
    }
  },
  {
    name: 'preheated_feed',
    type: 'Stream',
    properties: {
      Temperature: { value: 70, unit: 'C' }, // Pre-heated
      Pressure: { value: 2.8, unit: 'atm' }, // Pressure drop
      'Molar Flow': { value: 100, unit: 'kmol/h' },
    }
  },
  {
    name: 'feed_heater',
    type: 'Heater',
    properties: {
      Inlet: { value: 'preheated_feed' },
      Outlet: { value: 'heated_feed' },
      Duty: { value: 400, unit: 'kW' }, // Less duty needed now
      'Outlet Temperature': { value: 95, unit: 'C' }
    }
  },
  {
    name: 'heated_feed',
    type: 'Stream',
    properties: {
        Temperature: { value: 95, unit: 'C' },
        Pressure: { value: 2.6, unit: 'atm' },
        'Molar Flow': { value: 100, unit: 'kmol/h' }
    }
  },

  // --- Separation Section ---
  {
    name: 'distillation_column',
    type: 'DistillationColumn',
    properties: {
        Inlets: { value: ['heated_feed'] },
        'Top Outlet': { value: 'distillate' },
        'Bottom Outlet': { value: 'bottoms' },
        'Number of Stages': { value: 10 },
        'Feed Stage': { value: 5 },
        'Reflux Ratio': { value: 1.5 },
        'Boilup Ratio': { value: 2.0 }
    }
  },
  {
    name: 'distillate',
    type: 'Stream',
    properties: {
        Temperature: { value: 78, unit: 'C' },
        Pressure: { value: 1, unit: 'atm' },
        'Molar Flow': { value: 38, unit: 'kmol/h' },
        'Ethanol': { value: 0.95 },
        'Water': { value: 0.05 } 
    }
  },
  {
    name: 'bottoms',
    type: 'Stream',
    properties: {
        Temperature: { value: 102, unit: 'C' },
        Pressure: { value: 1.1, unit: 'atm' },
        'Molar Flow': { value: 62, unit: 'kmol/h' },
        'Ethanol': { value: 0.01 },
        'Water': { value: 0.99 }
    }
  },
  {
    name: 'cooled_bottoms', // From heat exchanger
    type: 'Stream',
    properties: {
      Temperature: { value: 45, unit: 'C' },
      Pressure: { value: 1, unit: 'atm' },
      'Molar Flow': { value: 62, unit: 'kmol/h' }
    }
  },

  // --- Reaction Section ---
  {
    name: 'distillate_compressor',
    type: 'Compressor',
    properties: {
      Inlet: { value: 'distillate' },
      Outlet: { value: 'compressed_distillate' },
      'Outlet Pressure': { value: 5, unit: 'atm' },
      'Isentropic Efficiency': { value: 0.75 },
      'Power Consumed': { value: 50, unit: 'kW'}
    }
  },
  {
    name: 'compressed_distillate',
    type: 'Stream',
    properties: {
      Temperature: { value: 120, unit: 'C' },
      Pressure: { value: 5, unit: 'atm' },
      'Molar Flow': { value: 38, unit: 'kmol/h' },
    }
  },
  {
    name: 'cstr_reactor',
    type: 'CSTR',
    properties: {
        Inlet: { value: 'compressed_distillate' },
        Outlet: { value: 'reactor_product' },
        Temperature: { value: 80, unit: 'C' },
        'Reaction Set': { value: 'Esterification' },
        'Conversion': { value: 0.85 }
    }
  },
  {
    name: 'reactor_product',
    type: 'Stream',
    properties: {
        Temperature: { value: 80, unit: 'C' },
        Pressure: { value: 4.8, unit: 'atm' },
        'Molar Flow': { value: 35, unit: 'kmol/h' },
        'Ethyl Acetate': { value: 0.82 },
        'Water': { value: 0.18 }
    }
  },
  
  // --- Settings ---
  {
    name: 'flowsheet_settings',
    type: 'FlowsheetSettings',
    properties: {
      'Thermodynamic Package': { value: null } 
    }
  }
];

const executeDwsimCommand = async (command: string): Promise<string> => {
    const parts = command.trim().split(/\s+/);
    const action = parts[0];

    const formatProperty = (prop: DWSIMProperty): string => {
        if (prop.value === null || prop.value === undefined) return 'N/A';
        const value = Array.isArray(prop.value) ? `[${prop.value.join(', ')}]` : prop.value;
        return prop.unit ? `${value} ${prop.unit}` : String(value);
    };

    switch (action) {
        case 'list_objects':
            return "Available objects:\n" + mockSimulationState.map(obj => `- ${obj.name} (${obj.type})`).join('\n');
        
        case 'get_all_properties': {
            const objName = parts[1];
            if (!objName) return "Error: Missing argument. Usage: get_all_properties <object_name>";
            const obj = mockSimulationState.find(o => o.name === objName);
            if (!obj) return `Error: Object '${objName}' not found.`;
            
            const properties = Object.entries(obj.properties);
            if (properties.length === 0) return `Object '${objName}' has no properties.`;
            
            const maxKeyLength = Math.max(...properties.map(([key]) => key.length));

            const formattedProperties = properties.map(([key, prop]) => {
                const paddedKey = key.padEnd(maxKeyLength, ' ');
                return `- ${paddedKey} : ${formatProperty(prop)}`;
            }).join('\n');

            return `Properties for ${obj.name}:\n` + formattedProperties;
        }

        case 'get_property': {
            const objName = parts[1];
            const propNameRaw = parts.slice(2);

            if (!objName) return "Error: Missing arguments. Usage: get_property <object_name> <property_name>";
            if (propNameRaw.length === 0) return `Error: Missing property name. Usage: get_property ${objName} <property_name>`;

            const obj = mockSimulationState.find(o => o.name === objName);
            if (!obj) return `Error: Object '${objName}' not found.`;
            
            const propName = propNameRaw.join(' ');
            const prop = obj.properties[propName];
            if (prop === undefined) return `Error: Property '${propName}' not found in object '${objName}'.`;
            
            return `${objName}.${propName}: ${formatProperty(prop)}`;
        }

        case 'calculate': {
            // --- Pre-calculation validation checks ---
            const VALID_THERMO_PACKAGES = ['Peng-Robinson', 'NRTL', 'UNIQUAC'];
            const settings = mockSimulationState.find(o => o.type === 'FlowsheetSettings');
            const currentPackage = settings?.properties['Thermodynamic Package']?.value;

            if (!currentPackage || !VALID_THERMO_PACKAGES.includes(String(currentPackage))) {
                return `Error: Calculation failed. Invalid or missing thermodynamic package. Current: '${currentPackage || 'None'}'. Please set a valid package (e.g., Peng-Robinson, NRTL).`;
            }

            const refluxRatioProp = mockSimulationState.find(o => o.name === 'distillation_column')?.properties['Reflux Ratio'];
            if(refluxRatioProp && typeof refluxRatioProp.value === 'number' && refluxRatioProp.value <= 0) {
                 return "Error: Calculation failed. Reflux ratio for 'distillation_column' must be positive.";
            }

            const heaters = mockSimulationState.filter(o => o.type === 'Heater');
            for (const heater of heaters) {
                const inletName = heater.properties['Inlet']?.value;
                const outletName = heater.properties['Outlet']?.value;
                const duty = heater.properties['Duty']?.value;

                if (typeof inletName !== 'string' || typeof outletName !== 'string' || typeof duty !== 'number') continue;
                const inletStream = mockSimulationState.find(o => o.name === inletName && o.type === 'Stream');
                const outletStream = mockSimulationState.find(o => o.name === outletName && o.type === 'Stream');
                if (!inletStream || !outletStream) continue;

                const inletTemp = inletStream.properties['Temperature']?.value;
                const outletTemp = outletStream.properties['Temperature']?.value;
                if (typeof inletTemp !== 'number' || typeof outletTemp !== 'number') continue;
                
                if (outletTemp <= inletTemp && duty > 0) {
                    return `Error: Calculation failed. Unachievable condition in heater '${heater.name}'. Outlet temperature (${outletTemp} C) cannot be less than or equal to inlet temperature (${inletTemp} C) with a positive duty (${duty} kW).`;
                }
                if (outletTemp > inletTemp && duty < 0) {
                     return `Error: Calculation failed. Unachievable condition in cooler '${heater.name}'. Outlet temperature (${outletTemp} C) cannot be greater than inlet temperature (${inletTemp} C) with a negative duty (${duty} kW).`;
                }
            }

            // --- If all checks pass, run calculation ---
            const mode = parts[1] || 'sync';
            if (mode === 'sync') {
                await new Promise(resolve => setTimeout(resolve, 1500)); // Simulate calculation time
                return "Flowsheet calculation completed successfully (Synchronous).";
            }
            if (mode === 'async') {
                return "Flowsheet calculation started in the background (Asynchronous).";
            }
            return `Error: Unknown calculation mode '${mode}'. Valid modes are 'sync' or 'async'.`;
        }
    
        default:
            return `Error: Unknown command '${action}'. Valid commands: list_objects, get_all_properties, get_property, calculate.`;
    }
};

const ToggleSwitch: React.FC<{ isChecked: boolean; onChange: (checked: boolean) => void; label: string; description: string; }> = ({ isChecked, onChange, label, description }) => (
    <label htmlFor="thinking-toggle" className="flex items-center cursor-pointer group">
        <div className="relative">
            <input id="thinking-toggle" type="checkbox" className="sr-only" checked={isChecked} onChange={e => onChange(e.target.checked)} />
            <div className={`block w-14 h-8 rounded-full transition-colors ${isChecked ? 'bg-cyan-600' : 'bg-slate-600 group-hover:bg-slate-500'}`}></div>
            <div className={`dot absolute left-1 top-1 bg-white w-6 h-6 rounded-full transition-transform ${isChecked ? 'transform translate-x-6' : ''}`}></div>
        </div>
        <div className="ml-3 text-sm">
            <span className="font-medium text-slate-300">{label}</span>
            <p className="text-xs text-slate-500">{description}</p>
        </div>
    </label>
);


const App: React.FC = () => {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [pyodideStatus, setPyodideStatus] = useState<PyodideStatus>('loading');
    const [isThinkingMode, setIsThinkingMode] = useState(false);
    const [image, setImage] = useState<{ data: string; mimeType: string; } | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    // Pre-load Pyodide on initial component mount
    useEffect(() => {
        getPyodide()
            .then(() => setPyodideStatus('ready'))
            .catch(e => {
                console.error("Pyodide failed to load", e);
                setPyodideStatus('error');
            });
    }, []);
    
    // Welcome message on initial load
    useEffect(() => {
        setMessages([
            {
                id: 'welcome-1',
                role: 'agent',
                content: {
                    plan: ["Greet the user and explain my capabilities."],
                    steps: [{
                        thought: "I need to introduce myself as an AI agent for chemical process simulation and provide examples of what I can do. I should also mention the new script execution and inspection features.",
                        tool: "FinalAnswer",
                        is_final_answer: true,
                        tool_output: "Hello! I am an AI agent designed to assist with chemical process simulations. You can upload images, run Python scripts, inspect the DWSIM environment, and visualize the flowsheet. \n\nWhat can you ask me? \n- 'Simulate the distillation of an ethanol-water mixture.'\n- 'Analyze this P&ID diagram and suggest improvements.' (with an image attached)\n- 'Show me a diagram of the current simulation.'"
                    }]
                }
            }
        ]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            if (!file.type.startsWith('image/')) {
                // In a real app, you'd show a user-facing error.
                console.error("Invalid file type. Please upload an image.");
                return;
            }
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64String = (reader.result as string).split(',')[1];
                setImage({
                    data: base64String,
                    mimeType: file.type,
                });
            };
            reader.readAsDataURL(file);
        }
    };
    
    const handleSendMessage = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim() || isLoading) return;

        const userMessage: UserMessage = {
            id: Date.now().toString(),
            role: 'user',
            content: input,
            image: image || undefined,
        };

        setMessages(prev => [...prev, userMessage]);
        setInput('');
        setImage(null);
        setIsLoading(true);

        try {
            const agentResponse = await runAgent(userMessage.content, isThinkingMode, userMessage.image);

            const agentMessage: AgentMessage = {
                id: (Date.now() + 1).toString(),
                role: 'agent',
                content: agentResponse,
            };
            setMessages(prev => [...prev, agentMessage]);
        } catch (error) {
            console.error(error);
            const errorMessage: AgentMessage = {
                id: (Date.now() + 1).toString(),
                role: 'agent',
                content: {
                    plan: ["Report error"],
                    steps: [{
                        thought: "An unexpected error occurred.",
                        tool: 'FinalAnswer',
                        is_final_answer: true,
                        tool_output: 'Sorry, something went wrong. Please try again.'
                    }]
                }
            };
            setMessages(prev => [...prev, errorMessage]);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="flex flex-col h-screen bg-slate-900 text-slate-100 font-sans">
            <header className="p-4 border-b border-slate-700 bg-slate-800/50 backdrop-blur-sm shadow-lg sticky top-0 z-10">
                <h1 className="text-2xl font-bold text-center text-cyan-400">Agentic AI for DWSIM</h1>
                <p className="text-center text-sm text-slate-400">A Simulated Agentic Workflow with Gemini</p>
            </header>
            
            <main className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
                {messages.map((msg) => (
                    <MessageRenderer key={msg.id} message={msg} pyodideStatus={pyodideStatus}/>
                ))}
                {isLoading && <LoadingIndicator />}
                <div ref={messagesEndRef} />
            </main>

            <footer className="p-4 border-t border-slate-700 bg-slate-800/50 sticky bottom-0">
                <div className="max-w-4xl mx-auto">
                    {image && (
                        <div className="relative self-start mb-2 w-fit">
                            <img src={`data:${image.mimeType};base64,${image.data}`} alt="upload preview" className="h-20 w-20 object-cover rounded-lg border-2 border-slate-500" />
                            <button 
                                onClick={() => setImage(null)} 
                                className="absolute -top-2 -right-2 bg-slate-700 rounded-full p-0.5 text-white hover:bg-slate-600 transition-colors"
                                aria-label="Remove image"
                            >
                                <CloseIcon className="w-5 h-5" />
                            </button>
                        </div>
                    )}
                    <div className="flex justify-center items-center gap-4 mb-3">
                        <ToggleSwitch
                            label="Thinking Mode"
                            description="Uses a more powerful model for complex tasks."
                            isChecked={isThinkingMode}
                            onChange={setIsThinkingMode}
                        />
                    </div>
                    <form onSubmit={handleSendMessage} className="flex items-center space-x-2">
                        <input type="file" ref={fileInputRef} onChange={handleImageUpload} accept="image/*" className="hidden" />
                        <button 
                            type="button" 
                            onClick={() => fileInputRef.current?.click()} 
                            disabled={isLoading} 
                            className="p-3 bg-slate-700 rounded-lg hover:bg-slate-600 disabled:bg-slate-800 disabled:cursor-not-allowed disabled:text-slate-500 transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-500"
                            aria-label="Upload image"
                        >
                            <ImageIcon className="w-6 h-6"/>
                        </button>
                        <textarea
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    handleSendMessage(e);
                                }
                            }}
                            placeholder="Ask the agent to perform a simulation..."
                            className="flex-1 p-3 bg-slate-700 rounded-lg focus:ring-2 focus:ring-cyan-500 focus:outline-none resize-none transition-shadow"
                            rows={1}
                            disabled={isLoading}
                        />
                        <button type="submit" disabled={isLoading || !input.trim()} className="p-3 bg-cyan-600 rounded-lg hover:bg-cyan-500 disabled:bg-slate-600 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2 focus:ring-offset-slate-900">
                            <SendIcon className="w-6 h-6"/>
                        </button>
                    </form>
                    <div className="text-center text-xs text-slate-500 pt-2">
                        Python Sandbox Status: 
                        <span className={`ml-1 font-semibold ${pyodideStatus === 'ready' ? 'text-green-400' : pyodideStatus === 'loading' ? 'text-yellow-400' : 'text-red-400'}`}>
                            {pyodideStatus.charAt(0).toUpperCase() + pyodideStatus.slice(1)}
                        </span>
                    </div>
                </div>
            </footer>
        </div>
    );
};

// --- Helper Components ---

const MessageRenderer: React.FC<{ message: ChatMessage; pyodideStatus: PyodideStatus }> = ({ message, pyodideStatus }) => {
    if (message.role === 'user') {
        return (
            <div className="flex items-start gap-4 max-w-4xl ml-auto justify-end">
                <div className="bg-blue-600 rounded-xl rounded-br-none p-4 max-w-2xl shadow-md">
                    {message.image && (
                        <img 
                            src={`data:${message.image.mimeType};base64,${message.image.data}`} 
                            alt="user upload" 
                            className="rounded-lg mb-2 max-h-60 w-auto"
                        />
                    )}
                    <p className="whitespace-pre-wrap">{message.content}</p>
                </div>
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-slate-600 flex items-center justify-center border-2 border-slate-500">
                    <UserIcon />
                </div>
            </div>
        );
    }
    
    return (
        <div className="flex items-start gap-4 max-w-4xl">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-slate-700 flex items-center justify-center border-2 border-cyan-500/50">
                <AgentIcon className="text-cyan-400"/>
            </div>
            <div className="flex-1 space-y-4">
                {message.content.plan && message.content.plan.length > 0 && (
                     <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-4 shadow-inner">
                        <h3 className="font-bold text-slate-300 mb-2">Plan:</h3>
                        <ul className="list-disc list-inside space-y-1 text-slate-400">
                            {message.content.plan.map((item, index) => <li key={index}>{item}</li>)}
                        </ul>
                    </div>
                )}
                {message.content.steps.map((step, index) => <AgentStepRenderer key={index} step={step} pyodideStatus={pyodideStatus} />)}
            </div>
        </div>
    );
};

const getToolIcon = (tool: AgentStep['tool']) => {
    switch (tool) {
        case 'Python': return <PythonIcon className="w-5 h-5 text-green-400" />;
        case 'DWSIM': return <DWSIMIcon className="w-5 h-5 text-blue-400" />;
        case 'DataAnalysis': return <DataAnalysisIcon className="w-5 h-5 text-purple-400" />;
        case 'Visualization': return <SitemapIcon className="w-5 h-5 text-orange-400" />;
        case 'FinalAnswer': return <FinalAnswerIcon className="w-5 h-5 text-emerald-400" />;
        default: return null;
    }
};

const CompositionChart: React.FC<{ data: { name: string; value: number }[] }> = ({ data }) => {
    const colors = ['bg-sky-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-indigo-500'];
    const total = data.reduce((sum, item) => sum + item.value, 0) || 1; // Avoid division by zero

    return (
        <div className="space-y-2 mt-3 p-3 bg-slate-900/50 rounded-lg">
            <h6 className="font-semibold text-slate-300 text-sm">Stream Composition:</h6>
            {data.map((item, index) => (
                <div key={item.name} className="flex items-center gap-3 text-sm animate-fade-in" style={{ animationDelay: `${index * 100}ms`}}>
                    <span className="w-28 truncate text-slate-400 text-right">{item.name}</span>
                    <div className="flex-1 bg-slate-700 rounded-full h-5 overflow-hidden">
                        <div
                            className={`${colors[index % colors.length]} h-full flex items-center justify-center text-white font-bold text-xs transition-all duration-500`}
                            style={{ width: `${(item.value / total) * 100}%` }}
                        >
                            {(item.value * 100).toFixed(1)}%
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
};

const PythonTool: React.FC<{ script: string; output: string | null; isExecuting: boolean }> = ({ script, output, isExecuting }) => {
    const isPythonError = output?.startsWith('Error:');
    return (
        <>
            <div className="mt-2">
                <h5 className="font-semibold text-slate-400 mb-1 text-sm">Script:</h5>
                <pre className="bg-black/50 p-3 rounded-md text-sm text-green-300 overflow-x-auto font-mono">
                    <code>{script}</code>
                </pre>
            </div>
            
            {(isExecuting || output !== null) && (
                <div className="mt-2">
                    <h5 className="flex items-center gap-2 font-semibold text-slate-400 mb-1 text-sm">
                        {isPythonError && <ErrorIcon className="w-4 h-4 text-red-400" />}
                        Execution Output:
                    </h5>
                    <div className={`p-3 rounded-md text-sm whitespace-pre-wrap overflow-x-auto font-mono ${isPythonError ? 'bg-red-900/30 text-red-200' : 'bg-slate-900/70 text-slate-300'}`}>
                        {isExecuting ? (
                             <div className="flex items-center text-slate-400">
                                <AgentIcon className="w-4 h-4 animate-spin mr-2" />
                                <span>Executing...</span>
                            </div>
                        ) : (
                            <code>{output}</code>
                        )}
                    </div>
                </div>
            )}
        </>
    );
};

const FlowsheetDiagram: React.FC<{ simulationState: DWSIMObject[] }> = ({ simulationState }) => {
    const nodeWidth = 140;
    const nodeHeight = 60;
    const nodeGapX = 60;
    const nodeGapY = 40;

    const nodePositions: { [key: string]: { x: number; y: number } } = {
        // Feed pre-processing
        'raw_feed': { x: 0, y: 1 },
        'feed_pump': { x: 1, y: 1 },
        'pressurized_feed': { x: 2, y: 1 },
        'feed_preheater': { x: 3, y: 1 },
        'preheated_feed': { x: 4, y: 1 },
        'feed_heater': { x: 5, y: 1 },
        'heated_feed': { x: 6, y: 1 },
        // Main separation
        'distillation_column': { x: 7, y: 1 },
        // Top product line
        'distillate': { x: 8, y: 0 },
        'distillate_compressor': { x: 9, y: 0 },
        'compressed_distillate': { x: 10, y: 0 },
        'cstr_reactor': { x: 11, y: 0 },
        'reactor_product': { x: 12, y: 0 },
        // Bottom product line (heat integration)
        'bottoms': { x: 7, y: 2 },
        'cooled_bottoms': { x: 3, y: 2 },
    };
    
    const connections: { from: string; to: string }[] = [];
    simulationState.forEach(obj => {
        if (obj.type === 'FlowsheetSettings') return;
        const props = obj.properties;

        // Outlets define a connection FROM this object TO the target stream
        ['Outlet', 'Top Outlet', 'Bottom Outlet', 'Hot Side Outlet', 'Cold Side Outlet'].forEach(propKey => {
            const prop = props[propKey];
            if (prop && prop.value) {
                const targets = Array.isArray(prop.value) ? prop.value : [prop.value];
                targets.forEach(target => {
                    connections.push({ from: obj.name, to: String(target) });
                });
            }
        });

        // Inlets define a connection FROM a source stream TO this object
        ['Inlet', 'Inlets', 'Hot Side Inlet', 'Cold Side Inlet'].forEach(propKey => {
            const prop = props[propKey];
            if (prop && prop.value) {
                const sources = Array.isArray(prop.value) ? prop.value : [prop.value];
                sources.forEach(source => {
                    connections.push({ from: String(source), to: obj.name });
                });
            }
        });
    });

    const getNodeColor = (type: DWSIMObject['type']) => {
        switch(type) {
            case 'Stream': return 'fill-sky-900/70 stroke-sky-500';
            case 'Heater': return 'fill-rose-900/70 stroke-rose-500';
            case 'Pump': return 'fill-teal-900/70 stroke-teal-500';
            case 'HeatExchanger': return 'fill-cyan-900/70 stroke-cyan-500';
            case 'Compressor': return 'fill-fuchsia-900/70 stroke-fuchsia-500';
            case 'DistillationColumn': return 'fill-amber-900/70 stroke-amber-500';
            case 'CSTR': return 'fill-indigo-900/70 stroke-indigo-500';
            default: return 'fill-slate-700 stroke-slate-500';
        }
    };

    return (
        <div className="bg-slate-900/50 p-4 rounded-lg border border-slate-700 mt-2">
            <svg width="100%" height="300" viewBox="0 0 2300 300">
                <defs>
                    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                        <path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" />
                    </marker>
                </defs>
                
                {/* Render connections */}
                {connections.map(({ from, to }, i) => {
                    const fromPos = nodePositions[from];
                    const toPos = nodePositions[to];
                    if (!fromPos || !toPos) return null;

                    const isReversed = fromPos.x > toPos.x;

                    // Standard Left to Right
                    const x1 = fromPos.x * (nodeWidth + nodeGapX) + (isReversed ? 0 : nodeWidth);
                    const y1 = fromPos.y * (nodeHeight + nodeGapY) + nodeHeight / 2;
                    const x2 = toPos.x * (nodeWidth + nodeGapX) + (isReversed ? nodeWidth : 0);
                    const y2 = toPos.y * (nodeHeight + nodeGapY) + nodeHeight / 2;
                    
                    let pathData;
                    if(isReversed) {
                        const midY = y1 + 80;
                        pathData = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
                    } else {
                        pathData = `M ${x1} ${y1} C ${x1 + nodeGapX / 2} ${y1}, ${x2 - nodeGapX / 2} ${y2}, ${x2} ${y2}`;
                    }


                    return <path key={i} d={pathData} stroke="#64748b" strokeWidth="2" fill="none" markerEnd="url(#arrow)" />;
                })}

                {/* Render nodes */}
                {simulationState.filter(obj => obj.type !== 'FlowsheetSettings').map(obj => {
                    const pos = nodePositions[obj.name];
                    if (!pos) return null;
                    const x = pos.x * (nodeWidth + nodeGapX);
                    const y = pos.y * (nodeHeight + nodeGapY);
                    
                    return (
                        <g key={obj.name} transform={`translate(${x}, ${y})`}>
                            <rect width={nodeWidth} height={nodeHeight} rx="8" className={getNodeColor(obj.type)} strokeWidth="2" />
                            <text x={nodeWidth / 2} y={nodeHeight / 2 - 8} textAnchor="middle" fill="#e2e8f0" fontSize="14" fontWeight="bold">{obj.name}</text>
                            <text x={nodeWidth / 2} y={nodeHeight / 2 + 12} textAnchor="middle" fill="#94a3b8" fontSize="12">{obj.type}</text>
                        </g>
                    );
                })}
            </svg>
        </div>
    );
};


const AgentStepRenderer: React.FC<{ step: AgentStep; pyodideStatus: PyodideStatus }> = ({ step, pyodideStatus }) => {
    const [isExecuting, setIsExecuting] = useState(false);
    const [execOutput, setExecOutput] = useState<string | null>(null);
    const [isInspecting, setIsInspecting] = useState(false);
    const [inspectionOutput, setInspectionOutput] = useState<string | null>(null);
    const [compositionData, setCompositionData] = useState<{ name: string; value: number; }[] | null>(null);
    const [showChart, setShowChart] = useState(false);

    const handleRunScript = async () => {
        if (!step.tool_input || pyodideStatus !== 'ready') return;
        setIsExecuting(true);
        setExecOutput(null);
        const result = await runPython(step.tool_input);
        setExecOutput(result);
        setIsExecuting(false);
    };

    const handleInspect = async () => {
        if (!step.tool_input) return;
        setIsInspecting(true);
        setInspectionOutput(null);
        setCompositionData(null);
        setShowChart(false);
        const result = await executeDwsimCommand(step.tool_input);
        setInspectionOutput(result);
        setIsInspecting(false);
    };
    
    const isPythonTool = step.tool === 'Python';
    const isDwsimTool = step.tool === 'DWSIM';
    const isDwsimError = inspectionOutput?.startsWith('Error:');
    
    useEffect(() => {
        if (inspectionOutput && isDwsimTool && !isDwsimError) {
            const lines = inspectionOutput.split('\n');
            const componentFractions: { name: string; value: number }[] = [];
            // Regex to find lines with component names and their fractional values (e.g., "- Ethanol : 0.4")
            const fractionRegex = /-\s*([A-Za-z\s]+?)\s*:\s*(\d\.\d+)\s*$/;

            lines.forEach(line => {
                const match = line.match(fractionRegex);
                if (match) {
                    const name = match[1].trim();
                    const value = parseFloat(match[2]);
                    // A simple heuristic: if the value is between 0 and 1, it's likely a component fraction.
                    if (value >= 0 && value <= 1) {
                         componentFractions.push({ name, value });
                    }
                }
            });
            
            if (componentFractions.length > 1) {
                setCompositionData(componentFractions);
            } else {
                setCompositionData(null);
            }
        } else {
            setCompositionData(null);
        }
    }, [inspectionOutput, isDwsimTool, isDwsimError]);


    const dwsimCommand = step.tool_input?.trim().split(/\s+/)[0];
    const isCalculateCommand = dwsimCommand === 'calculate';

    const dwsimButtonText = isCalculateCommand ? 'Calculate' : 'Inspect';
    const dwsimButtonIcon = isCalculateCommand ? <PlayIcon className="w-4 h-4" /> : <SearchIcon className="w-4 h-4" />;
    const dwsimLoadingText = isCalculateCommand ? 'Calculating...' : 'Inspecting...';

    return (
        <div className="bg-slate-800 rounded-lg border border-slate-700 overflow-hidden shadow-md">
            <div className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        {getToolIcon(step.tool)}
                        <h4 className="font-semibold text-lg text-slate-200">Using Tool: {step.tool}</h4>
                    </div>
                    {isPythonTool && (
                        <button 
                            onClick={handleRunScript} 
                            disabled={isExecuting || pyodideStatus !== 'ready'}
                            className="flex items-center gap-2 px-3 py-1.5 text-sm bg-green-600/50 text-green-200 rounded-md hover:bg-green-600/80 disabled:bg-slate-600 disabled:text-slate-400 disabled:cursor-not-allowed transition-colors"
                            title={pyodideStatus !== 'ready' ? `Python sandbox is ${pyodideStatus}...` : 'Execute script'}
                        >
                            {isExecuting ? <AgentIcon className="w-4 h-4 animate-spin" /> : <PlayIcon className="w-4 h-4" />}
                            {isExecuting ? 'Executing...' : 'Run Script'}
                        </button>
                    )}
                     {isDwsimTool && (
                        <button 
                            onClick={handleInspect} 
                            disabled={isInspecting}
                            className="flex items-center gap-2 px-3 py-1.5 text-sm bg-blue-600/50 text-blue-200 rounded-md hover:bg-blue-600/80 disabled:bg-slate-600 disabled:text-slate-400 disabled:cursor-not-allowed transition-colors"
                            title={isCalculateCommand ? "Run simulation calculation" : "Inspect simulation state"}
                        >
                            {isInspecting ? <AgentIcon className="w-4 h-4 animate-spin" /> : dwsimButtonIcon}
                            {isInspecting ? dwsimLoadingText : dwsimButtonText}
                        </button>
                    )}
                </div>

                <div className="pl-8 border-l-2 border-slate-600 ml-2.5">
                    <p className="italic text-slate-400">"{step.thought}"</p>
                </div>
                
                {isPythonTool && step.tool_input && (
                     <PythonTool script={step.tool_input} output={execOutput} isExecuting={isExecuting} />
                )}

                {isDwsimTool && step.tool_input && (
                     <div className="mt-2">
                        <h5 className="font-semibold text-slate-400 mb-1 text-sm">Command:</h5>
                        <pre className="bg-black/50 p-3 rounded-md text-sm text-green-300 overflow-x-auto font-mono">
                            <code>{step.tool_input}</code>
                        </pre>
                    </div>
                )}
                
                {isDwsimTool && inspectionOutput && (
                    <div className="mt-2">
                        <h5 className="flex items-center gap-2 font-semibold text-slate-400 mb-1 text-sm">
                           {isDwsimError && <ErrorIcon className="w-4 h-4 text-red-400" />}
                           Inspection Result:
                        </h5>
                        <pre className={`p-3 rounded-md text-sm whitespace-pre-wrap font-mono ${isDwsimError ? 'bg-red-900/30 text-red-200' : 'bg-blue-900/30 text-blue-200'}`}>
                           <code>{inspectionOutput}</code>
                        </pre>
                        {compositionData && (
                            <div className="mt-3">
                                <button 
                                    onClick={() => setShowChart(!showChart)}
                                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-sky-600/50 text-sky-200 rounded-md hover:bg-sky-600/80 transition-colors"
                                >
                                    <ChartBarIcon className="w-4 h-4" />
                                    {showChart ? 'Hide Visualization' : 'Visualize Composition'}
                                </button>
                                {showChart && <CompositionChart data={compositionData} />}
                            </div>
                        )}
                   </div>
                )}

                {step.tool === 'Visualization' && (
                    <div className="mt-2">
                         <h5 className="font-semibold text-slate-400 mb-1 text-sm">Flowsheet Diagram:</h5>
                         {step.tool_output && <p className="text-slate-300 text-sm mb-2">{step.tool_output}</p>}
                         <FlowsheetDiagram simulationState={mockSimulationState} />
                    </div>
                )}
                
                {step.tool === 'DataAnalysis' && step.tool_output && (
                    <div className="mt-2">
                         <h5 className="font-semibold text-slate-400 mb-1 text-sm">Analysis Summary:</h5>
                         <div className="bg-purple-900/30 p-3 rounded-md text-sm text-purple-200 whitespace-pre-wrap">
                            {step.tool_output}
                         </div>
                    </div>
                )}

                {step.tool === 'FinalAnswer' && step.tool_output && (
                    <div className="mt-2">
                         <h5 className="font-semibold text-slate-400 mb-1 text-sm">Final Answer:</h5>
                         <div className="bg-emerald-900/40 border border-emerald-500/50 p-3 rounded-md text-sm text-emerald-200 whitespace-pre-wrap">
                            {step.tool_output}
                         </div>
                    </div>
                )}
            </div>
        </div>
    );
};

const LoadingIndicator: React.FC = () => (
    <div className="flex items-start gap-4 max-w-4xl">
        <div className="flex-shrink-0 w-10 h-10 rounded-full bg-slate-700 flex items-center justify-center border-2 border-cyan-500/50">
            <AgentIcon className="text-cyan-400 animate-spin"/>
        </div>
        <div className="bg-slate-800 rounded-xl rounded-tl-none p-4 shadow-md">
            <div className="flex items-center space-x-2">
                <div className="w-2 h-2 bg-slate-500 rounded-full animate-pulse"></div>
                <div className="w-2 h-2 bg-slate-500 rounded-full animate-pulse" style={{ animationDelay: '200ms' }}></div>
                <div className="w-2 h-2 bg-slate-500 rounded-full animate-pulse" style={{ animationDelay: '400ms' }}></div>
            </div>
        </div>
    </div>
);

export default App;