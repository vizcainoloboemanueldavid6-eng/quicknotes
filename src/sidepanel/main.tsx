import { render } from 'preact';
import '../styles/ui.css';
import { initPage } from '../ui/theme';
import { SidePanel } from './SidePanel';

initPage();
const root = document.getElementById('app');
if (root) render(<SidePanel />, root);
