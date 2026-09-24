import { render } from 'preact';
import '../styles/ui.css';
import { t } from '../lib/i18n';
import { initPage } from '../ui/theme';
import { Options } from './Options';

initPage();
document.title = t('optionsTitle');
const root = document.getElementById('app');
if (root) render(<Options />, root);
