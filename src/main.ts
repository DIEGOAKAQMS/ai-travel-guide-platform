import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'

import 'cesium/Build/Cesium/Widgets/widgets.css'
import './styles/index.css'

createApp(App).use(createPinia()).mount('#app')
