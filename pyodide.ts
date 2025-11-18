import type { PyodideInterface } from 'pyodide';

// This is a global declaration for the `loadPyodide` function
// which is loaded from the Pyodide CDN.
declare global {
  interface Window {
    loadPyodide: (config: { indexURL: string }) => Promise<PyodideInterface>;
  }
}

// A promise that resolves to the Pyodide instance.
// This ensures Pyodide is loaded only once.
let pyodidePromise: Promise<PyodideInterface> | null = null;

const EXECUTION_TIMEOUT = 5000; // 5 seconds

/**
 * A prelude script to set up a secure, mocked environment for Python execution.
 * This script is run before any agent-generated code.
 */
const PYTHON_SANDBOX_PRELUDE = `
import sys
from types import ModuleType
import logging
import io

# --- Security Hardening ---
# 1. Disable networking and filesystem access
class RestrictedModule:
    def __getattr__(self, name):
        raise ImportError(f"Module '{self.__name__}' is disabled in this sandbox.")

sys.modules['socket'] = RestrictedModule()
sys.modules['urllib'] = RestrictedModule()
sys.modules['urllib.request'] = RestrictedModule()
sys.modules['os'] = RestrictedModule()
sys.modules['shutil'] = RestrictedModule()
sys.modules['subprocess'] = RestrictedModule()

# 2. Prevent loading new packages
if 'micropip' in sys.modules:
    del sys.modules['micropip']

# 3. Disable JavaScript interop
if 'js' in sys.modules:
    del sys.modules['js']

print("--- Secure Sandbox Initialized ---")
print("Networking, file system, and package installation are disabled.")

# --- Logging System ---
log_capture_string = io.StringIO()
root_logger = logging.getLogger()
root_logger.setLevel(logging.INFO) # Default level
formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
string_handler = logging.StreamHandler(log_capture_string)
string_handler.setFormatter(formatter)
root_logger.addHandler(string_handler)

def configure_logging(level='INFO', destination='capture'):
    """
    Configures the logging level and destination for the root logger.
    - level: 'DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'
    - destination: 'capture' (default, to string), 'console' (to stdout)
    """
    log_level = getattr(logging, level.upper(), logging.INFO)
    root_logger.setLevel(log_level)
    
    # Clear existing handlers to prevent duplicate messages
    for handler in root_logger.handlers[:]:
        root_logger.removeHandler(handler)
        
    if destination == 'capture':
        root_logger.addHandler(string_handler)
        print(f"[Logging] Log level set to {level.upper()}, destination: capture.")
    else:
        console_handler = logging.StreamHandler(sys.stdout)
        console_handler.setFormatter(formatter)
        root_logger.addHandler(console_handler)
        print(f"[Logging] Log level set to {level.upper()}, destination: console.")

# Make logging and the config function available globally
globals()['logging'] = logging
globals()['configure_logging'] = configure_logging

print("--- Logging System Initialized ---")

# --- Mock DWSIM Environment ---
class MockObject:
    def __init__(self, name=""):
        self._name = name
        self._props = {}
        logging.debug(f"[DWSIM MOCK] Created mock object: {name if name else 'unnamed'}")

    def SetOverallCompoundFraction(self, compound, value):
        logging.info(f"[DWSIM MOCK] Setting {compound} fraction to {value} in '{self._name}'")
        self._props[compound] = value

    def GetOverallCompoundFraction(self, compound):
        val = self._props.get(compound, 0.5)
        logging.info(f"[DWSIM MOCK] Getting {compound} fraction from '{self._name}'. Returning default: {val}")
        return val

    def Set(self, prop_name, value):
        logging.info(f"[DWSIM MOCK] Setting property '{prop_name}' to '{value}' in '{self._name}'")
        self._props[prop_name] = value

    def GetProperty(self, prop_name):
        val = self._props.get(prop_name, "mock_value")
        logging.info(f"[DWSIM MOCK] Getting property '{prop_name}' from '{self._name}'. Returning default: '{val}'")
        return val

class MockFlowsheet:
    def GetObject(self, name):
        logging.info(f"[DWSIM MOCK] Accessing object '{name}' from flowsheet.")
        return MockObject(name)
    
    def SetThermodynamicPackage(self, name):
        logging.info(f"[DWSIM MOCK] Setting thermodynamic package to: {name}")

    def Connect(self, source, target):
        logging.info(f"[DWSIM MOCK] Connecting '{source}' to '{target}'")

    def Calculate(self, _=None):
        logging.info("[DWSIM MOCK] Calculating flowsheet...")
        logging.info("[DWSIM MOCK] Calculation complete.")

    def GetCalculationStatus(self):
        logging.info("[DWSIM MOCK] Checking calculation status. Returning 'Solved'.")
        return "Solved"

# Correctly mock the DWSIM package structure to support imports like 'from DWSIM.Automation import ...'
# 1. Define the Automation interface class
class MockAutomation:
    def __init__(self):
        logging.debug("[DWSIM MOCK] Automation interface created.")
    
    @staticmethod
    def GetFlowsheet(path=None):
        path_info = f"from path: {path}" if path else "(no path specified, creating new)"
        logging.info(f"[DWSIM MOCK] Getting flowsheet {path_info}")
        return MockFlowsheet()

# 2. Create a mock for the DWSIM.Automation submodule and add the class to it
automation_module = ModuleType('DWSIM.Automation')
automation_module.Automation = MockAutomation  # Assign the CLASS, not an instance
sys.modules['DWSIM.Automation'] = automation_module

# 3. Create the top-level DWSIM package
dwsim_package = ModuleType('DWSIM')
dwsim_package.Automation = automation_module # Attach the module to the package
# Set __path__ to indicate it is a package, allowing submodule imports
dwsim_package.__path__ = []
sys.modules['DWSIM'] = dwsim_package

# 4. For convenience, make DWSIM available as a global variable
DWSIM = dwsim_package
print("--- DWSIM Mock Initialized ---")

# --- Pre-initialize a default simulation environment ---
# This makes the sandbox easier for the agent to use, avoiding boilerplate.
print("--- Initializing Default Simulation Environment ---")
interf = DWSIM.Automation.Automation()
flowsheet = interf.GetFlowsheet()

# Create global variables for all objects in the mock simulation state
# This allows the agent to directly use names like 'distillation_column'
mock_object_names = [
  'raw_feed', 'feed_pump', 'pressurized_feed', 'feed_preheater',
  'preheated_feed', 'feed_heater', 'heated_feed', 'distillation_column',
  'distillate', 'bottoms', 'cooled_bottoms', 'distillate_compressor',
  'compressed_distillate', 'cstr_reactor', 'reactor_product'
]

for obj_name in mock_object_names:
    # Use globals() to create a global variable with the object's name
    globals()[obj_name] = flowsheet.GetObject(obj_name)
    logging.debug(f"Created global variable for DWSIM object: '{obj_name}'")

print("--- Environment Ready ---")
`;

/**
 * Loads the Pyodide instance.
 * @returns A promise that resolves to the Pyodide interface.
 */
export function getPyodide(): Promise<PyodideInterface> {
  if (!pyodidePromise) {
    pyodidePromise = window.loadPyodide({
      indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.25.1/full/',
    }).then(pyodide => {
      console.log("Pyodide loaded successfully.");
      // Run the security prelude once on load.
      pyodide.runPython(PYTHON_SANDBOX_PRELUDE);
      return pyodide;
    });
  }
  return pyodidePromise;
}

/**
 * Runs a Python script in the secured Pyodide environment with a timeout.
 * It captures and returns stdout, stderr, and logs.
 * @param code The Python code to execute.
 * @returns A promise that resolves to the script's output string.
 */
export async function runPython(code: string): Promise<string> {
  const pyodide = await getPyodide();
  try {
    let stdout = '';
    let stderr = '';
    // Redirect stdout and stderr to capture output
    pyodide.setStdout({ batched: (str) => { stdout += str + '\n'; } });
    pyodide.setStderr({ batched: (str) => { stderr += str + '\n'; } });

    // Race the python execution against a timeout
    const executionPromise = pyodide.runPythonAsync(code);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Execution timed out after ${EXECUTION_TIMEOUT / 1000} seconds.`)), EXECUTION_TIMEOUT)
    );

    await Promise.race([executionPromise, timeoutPromise]);
    
    // After execution, get the captured logs and clear the buffer
    const capturedLogs = pyodide.globals.get('log_capture_string').getvalue();
    pyodide.runPython('log_capture_string.truncate(0); log_capture_string.seek(0)');

    // Combine stdout, stderr, and logs for the final output
    let finalOutput = (stdout + stderr).trim();
    if (capturedLogs) {
      finalOutput += `\n\n--- Captured Logs ---\n${capturedLogs.trim()}`;
    }
    
    return finalOutput.trim();
  } catch (e) {
    console.error("Error running Python code:", e);
    const errorMessage = e instanceof Error ? e.message : String(e);
    return `Error: ${errorMessage}`;
  } finally {
    // Reset streams after execution to avoid memory leaks
    pyodide.setStdout({ batched: () => {} });
    pyodide.setStderr({ batched: () => {} });
  }
}