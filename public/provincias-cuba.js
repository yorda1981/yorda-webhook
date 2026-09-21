/* ═══════════════════════════════════════════
   Catálogo único de Provincias/Municipios de Cuba
   ═══════════════════════════════════════════
   Fuente única -- la usan public/calculadora.html (cliente) y
   public/dashboard.html (formulario de "Nueva entrega manual" del CRM de
   Entregas). Nunca se mantiene una segunda copia: cualquier cambio a este
   catálogo se hace en este único archivo.

   Script clásico (no type="module") a propósito: ambas páginas lo cargan
   con <script src="/provincias-cuba.js"></script> antes de su propio
   <script> inline, y el `const PROVINCIAS` de nivel superior queda
   disponible en el resto de la página (mismo scope global del documento,
   comportamiento estándar de <script> clásicos secuenciales). */
"use strict";

// Provincias de Cuba + municipio cabecera (entrega directa) + zona (plazo de entrega)
const PROVINCIAS = [
  { nombre:"Pinar del Río", cabecera:"Pinar del Río", zona:"resto", municipios:["Consolación del Sur","Guane","La Palma","Los Palacios","Mantua","Minas de Matahambre","Pinar del Río","San Juan y Martínez","San Luis","Sandino","Viñales"] },
  { nombre:"Artemisa", cabecera:"Artemisa", zona:"resto", municipios:["Alquízar","Artemisa","Bahía Honda","Bauta","Caimito","Candelaria","Guanajay","Güira de Melena","Mariel","San Antonio de los Baños","San Cristóbal"] },
  { nombre:"La Habana", cabecera:"Plaza de la Revolución", zona:"habana", municipios:["Arroyo Naranjo","Boyeros","Centro Habana","Cerro","Cotorro","Diez de Octubre","Guanabacoa","Habana del Este","Habana Vieja","La Lisa","Marianao","Playa","Plaza de la Revolución","Regla","San Miguel del Padrón"] },
  { nombre:"Mayabeque", cabecera:"San José de las Lajas", zona:"resto", municipios:["Batabanó","Bejucal","Güines","Jaruco","Madruga","Melena del Sur","Nueva Paz","Quivicán","San José de las Lajas","San Nicolás","Santa Cruz del Norte"] },
  { nombre:"Matanzas", cabecera:"Matanzas", zona:"resto", municipios:["Calimete","Cárdenas","Ciénaga de Zapata","Colón","Jagüey Grande","Jovellanos","Limonar","Los Arabos","Martí","Matanzas","Pedro Betancourt","Perico","Unión de Reyes"] },
  { nombre:"Villa Clara", cabecera:"Santa Clara", zona:"resto", municipios:["Caibarién","Camajuaní","Cifuentes","Corralillo","Encrucijada","Manicaragua","Placetas","Quemado de Güines","Ranchuelo","Remedios","Sagua la Grande","Santa Clara","Santo Domingo"] },
  { nombre:"Cienfuegos", cabecera:"Cienfuegos", zona:"resto", municipios:["Abreus","Aguada de Pasajeros","Camarones","Cienfuegos","Cruces","Cumanayagua","Lajas","Palmira","Rodas"] },
  { nombre:"Sancti Spíritus", cabecera:"Sancti Spíritus", zona:"resto", municipios:["Cabaiguán","Fomento","Jatibonico","La Sierpe","Sancti Spíritus","Taguasco","Trinidad","Yaguajay"] },
  { nombre:"Ciego de Ávila", cabecera:"Ciego de Ávila", zona:"resto", municipios:["Baraguá","Bolivia","Chambas","Ciego de Ávila","Ciro Redondo","Florencia","Majagua","Morón","Primero de Enero","Venezuela"] },
  { nombre:"Camagüey", cabecera:"Camagüey", zona:"resto", municipios:["Camagüey","Carlos Manuel de Céspedes","Esmeralda","Florida","Guáimaro","Jimaguayú","Minas","Najasa","Nuevitas","Santa Cruz del Sur","Sibanicú","Sierra de Cubitas","Vertientes"] },
  { nombre:"Las Tunas", cabecera:"Las Tunas", zona:"resto", municipios:["Amancio","Colombia","Jesús Menéndez","Jobabo","Las Tunas","Majibacoa","Manatí","Puerto Padre"] },
  { nombre:"Holguín", cabecera:"Holguín", zona:"resto", municipios:["Antilla","Báguano","Banes","Cacocum","Calixto García","Cueto","Frank País","Gibara","Holguín","Mayarí","Moa","Rafael Freyre","Sagua de Tánamo","Urbano Noris"] },
  { nombre:"Granma", cabecera:"Bayamo", zona:"resto", municipios:["Bartolomé Masó","Bayamo","Buey Arriba","Campechuela","Cauto Cristo","Guisa","Jiguaní","Manzanillo","Media Luna","Niquero","Pilón","Río Cauto","Yara"] },
  { nombre:"Santiago de Cuba", cabecera:"Santiago de Cuba", zona:"resto", municipios:["Contramaestre","Guamá","Mella","Palma Soriano","San Luis","Santiago de Cuba","Segundo Frente","Songo-La Maya","Tercer Frente"] },
  { nombre:"Guantánamo", cabecera:"Guantánamo", zona:"resto", municipios:["Baracoa","Caimanera","El Salvador","Guantánamo","Imías","Maisí","Manuel Tames","Niceto Pérez","San Antonio del Sur","Yateras"] },
  { nombre:"Isla de la Juventud", cabecera:"Isla de la Juventud", zona:"resto", municipios:["Isla de la Juventud"] },
];
