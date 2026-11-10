
import path from 'path';
import { fileURLToPath } from 'url';

export const __filename = fileURLToPath(import.meta.url); // get the resolved path 
export const __dirname = path.dirname(__filename);


export default { PROJECT_DIR: __dirname }; 
