// The whole card gallery: the claim scenarios' cards and the appeal loop's, each as a real tool returned it.
import { appealGalleryCards } from "./appeal-scenarios";
import { galleryCards } from "./scenarios";

export const allGalleryCards = () => [...galleryCards(), ...appealGalleryCards()];
