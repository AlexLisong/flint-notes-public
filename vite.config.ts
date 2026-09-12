import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],server:{port:5191,strictPort:true,proxy:{'/api':'http://127.0.0.1:4317','/published':'http://127.0.0.1:4317'}},build:{sourcemap:false}});
