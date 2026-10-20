import { createRoot } from 'react-dom/client';
import { AtlasLab } from './AtlasLab';
import { MissionApp } from './MissionApp';

const root = document.getElementById('root');
if (!root) throw new Error('ATLAS Lab root element is missing.');
const legacyMode = new URLSearchParams(location.search).has('mode');
createRoot(root).render(legacyMode ? <AtlasLab /> : <MissionApp />);
