import Phaser from 'phaser';
import { PHASER_CONFIG } from './PlayScene';

export function createGame(): Phaser.Game { return new Phaser.Game(PHASER_CONFIG); }
