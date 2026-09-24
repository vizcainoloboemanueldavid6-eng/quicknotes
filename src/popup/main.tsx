import { render } from 'preact';
import '../styles/ui.css';
import { initPage } from '../ui/theme';
import { Popup } from './Popup';

initPage();
const root = document.getElementById('app');
if (root) render(<Popup />, root);
