import type { ComponentCategory } from './types.js';

/**
 * Metadata for each seed photo: source URL, local filename,
 * and the component properties for the database row.
 */
export interface SeedPhotoSpec {
  url: string;
  filename: string;
  category: ComponentCategory;
  brand: string;
  partNumber: string | null;
}

/**
 * Curated set of 14 real photos. 12 individually verified against Wikimedia
 * Commons (explicitly freely licensed); 2 sourced directly from the
 * respective manufacturer's own official site (Montech, Apevia — neither
 * has Commons coverage), each a single real product photo pulled for
 * internal comparison use only, never redistributed — see T3's plan notes
 * for the license distinction between the two sourcing methods. Categories:
 * GPU (4), Case (4), Cooler (4), Motherboard (1), PSU (1).
 */
export const SEED_PHOTOS: readonly SeedPhotoSpec[] = [
  // GPUs
  {
    url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/2/2d/Amd-radeon-rx6800xt-from2020year-front.jpg/960px-Amd-radeon-rx6800xt-from2020year-front.jpg',
    filename: 'amd-rx6800xt-reference.jpg',
    category: 'GPU',
    brand: 'AMD',
    partNumber: 'RX 6800 XT',
  },
  {
    url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/9/91/Gigabyte_GeForce_RTX_3090_Eagle_OC_24G%2C_24576_MiB_GDDR6X_Front_20201114_DSC5880.jpg/960px-Gigabyte_GeForce_RTX_3090_Eagle_OC_24G%2C_24576_MiB_GDDR6X_Front_20201114_DSC5880.jpg',
    filename: 'gigabyte-rtx3090-eagle-oc.jpg',
    category: 'GPU',
    brand: 'Gigabyte',
    partNumber: 'GeForce RTX 3090 Eagle OC',
  },
  {
    url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/b/b9/MSI_GeForce_RTX_3070_VENTUS_3X_OC.jpg/960px-MSI_GeForce_RTX_3070_VENTUS_3X_OC.jpg',
    filename: 'msi-rtx3070-ventus3x-oc.jpg',
    category: 'GPU',
    brand: 'MSI',
    partNumber: 'GeForce RTX 3070 Ventus 3X OC',
  },
  {
    url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/1/13/EVGA_GeForce_GTX_1050_Superclocked%2C_front.jpg/960px-EVGA_GeForce_GTX_1050_Superclocked%2C_front.jpg',
    filename: 'evga-gtx1050-superclocked.jpg',
    category: 'GPU',
    brand: 'EVGA',
    partNumber: 'GeForce GTX 1050 Superclocked',
  },
  // Cases
  {
    url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/1/18/NZXT_H500i_case_empty_10-13-2018.jpg/960px-NZXT_H500i_case_empty_10-13-2018.jpg',
    filename: 'nzxt-h500i.jpg',
    category: 'Case',
    brand: 'NZXT',
    partNumber: 'H500i',
  },
  {
    url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/8/85/Corsair_4000D_Airflow_mid-tower_ATX_case.tif/lossy-page1-960px-Corsair_4000D_Airflow_mid-tower_ATX_case.tif.jpg',
    filename: 'corsair-4000d-airflow.jpg',
    category: 'Case',
    brand: 'Corsair',
    partNumber: '4000D Airflow',
  },
  {
    url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/f/fb/Fractal_Design_Focus_G.jpg/960px-Fractal_Design_Focus_G.jpg',
    filename: 'fractal-focus-g.jpg',
    category: 'Case',
    brand: 'Fractal Design',
    partNumber: 'Focus G',
  },
  {
    url: 'https://www.montechpc.com/images/375589?stamp=1734688166',
    filename: 'montech-air903max.webp',
    category: 'Case',
    brand: 'Montech',
    partNumber: 'AIR 903 MAX',
  },
  // Coolers
  {
    url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/8/88/AMD_Wraith_Spire_cooler.jpg/960px-AMD_Wraith_Spire_cooler.jpg',
    filename: 'amd-wraith-spire.jpg',
    category: 'Cooler',
    brand: 'AMD',
    partNumber: 'Wraith Spire',
  },
  {
    url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/e/ee/CPU-Cooler-Intel.jpg/960px-CPU-Cooler-Intel.jpg',
    filename: 'intel-boxed-cooler.jpg',
    category: 'Cooler',
    brand: 'Intel',
    partNumber: 'Boxed Cooler (stock)',
  },
  {
    url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/7/7c/2023_Ch%C5%82odzenie_procesora_be_quiet%21_Dark_Rock_Top_Flow_%281%29.jpg/960px-2023_Ch%C5%82odzenie_procesora_be_quiet%21_Dark_Rock_Top_Flow_%281%29.jpg',
    filename: 'bequiet-dark-rock-top-flow.jpg',
    category: 'Cooler',
    brand: 'be quiet!',
    partNumber: 'Dark Rock TF',
  },
  {
    url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/3/38/NH-D15_with_classic_fans.jpg/960px-NH-D15_with_classic_fans.jpg',
    filename: 'noctua-nh-d15.jpg',
    category: 'Cooler',
    brand: 'Noctua',
    partNumber: 'NH-D15',
  },
  // Motherboards
  {
    url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/7/7b/Asus-ROG-Strix-Z390-F-Gaming-Motherboard_20201120_DSC6025.jpg/960px-Asus-ROG-Strix-Z390-F-Gaming-Motherboard_20201120_DSC6025.jpg',
    filename: 'asus-rog-strix-z390-f-gaming.jpg',
    category: 'Motherboard',
    brand: 'ASUS',
    partNumber: 'ROG Strix Z390-F Gaming',
  },
  // PSUs
  {
    url: 'https://cdn.prod.website-files.com/5ced3cdc3850586f0800b1a0/605271de1eb69bda18fe4e7e_ATX-ES600-WH-1.jpg',
    filename: 'apevia-atx-es600-wh.jpg',
    category: 'PSU',
    brand: 'Apevia',
    partNumber: 'ATX-ES600-WH',
  },
];
