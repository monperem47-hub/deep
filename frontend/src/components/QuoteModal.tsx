import { useState } from 'react';
import type { QuoteRequest } from '../types/index';
import { X, Send, AlertCircle } from 'lucide-react';
import { useAppContext } from '../context/AppContext';
import { useNavigate } from 'react-router-dom';

export default function QuoteModal() {
  const { state, dispatch } = useAppContext();
  const navigate = useNavigate();
  const [formData, setFormData] = useState<{
    name: string;
    email: string;
    phone: string;
    company: string;
    message: string;
  }>({
    name: '',
    email: '',
    phone: '',
    company: '',
    message: ''
  });
  const [showTemplate, setShowTemplate] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!state.isQuoteModalOpen) return null;

  const products = state.selectedProduct 
    ? [{ product: state.selectedProduct, quantity: 1, selectedVariations: {}, totalPrice: state.selectedProduct.price }]
    : state.cart;

  // Lire la clé API depuis les variables d'environnement Vite et la normaliser (trim)
  const rawApiKey = (import.meta.env as any).VITE_API_KEY || '';
  const apiKey = rawApiKey.toString().trim();
  if (!apiKey) {
    console.warn('VITE_API_KEY n\'est pas défini. Les requêtes /send-quote seront rejetées avec 401.');
  }

  // URL Backend : préférer un VITE_BACKEND_URL explicite, sinon utiliser un chemin relatif
  const backendBase = ((import.meta.env as any).VITE_BACKEND_URL || '').trim();
  const sendQuoteUrl = backendBase
    ? `${backendBase.replace(/\/$/, '')}/send-quote`
    : '/send-quote';

  console.log('Configuration:', {
    apiKey: apiKey ? 'Configuré' : 'Non configuré',
    backendUrl: sendQuoteUrl,
    environment: import.meta.env.MODE
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (isSubmitting) return;
    
    setError(null);
    setIsSubmitting(true);

    try {
      // Vérification de l'authentification utilisateur
      if (!state || !state.userId) {
        navigate('/login');
        return;
      }

      // Validation côté client
      if (!formData.name.trim() || !formData.email.trim() || !formData.phone.trim()) {
        setError('Veuillez remplir tous les champs obligatoires.');
        return;
      }

      if (products.length === 0) {
        setError('Aucun produit sélectionné pour le devis.');
        return;
      }

      // Vérification de la clé API
      if (!apiKey) {
        setError('Configuration manquante. Veuillez contacter l\'administrateur.');
        return;
      }

      const quoteRequest: QuoteRequest = {
        ...formData,
        products,
        message: formData.message || `Bonjour, je souhaite recevoir un devis pour les produits sélectionnés. Merci de me contacter avec vos meilleures conditions.`
      };

      console.log('Envoi de la demande de devis à:', sendQuoteUrl);
      console.log('Données:', JSON.stringify(quoteRequest, null, 2));

      // Envoi de la requête
      const resp = await fetch(sendQuoteUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey
        },
        body: JSON.stringify(quoteRequest)
      });

      console.log('Statut de la réponse send-quote:', resp.status);

      if (!resp.ok) {
        // Tentative de parser le message d'erreur JSON
        let errBody = null;
        try { 
          errBody = await resp.json(); 
        } catch (e) { 
          console.warn('Impossible de parser la réponse d\'erreur JSON:', e);
        }
        
        const errMsg = (errBody && (errBody.error || errBody.message)) || resp.statusText || `HTTP ${resp.status}`;
        
        // Messages d'erreur spécifiques
        if (resp.status === 401) {
          throw new Error('Erreur d\'authentification. Veuillez vérifier la configuration.');
        } else if (resp.status === 500) {
          throw new Error('Erreur serveur. Veuillez réessayer plus tard.');
        } else if (resp.status === 400) {
          throw new Error('Données invalides. Veuillez vérifier vos informations.');
        }
        
        throw new Error(errMsg);
      }

      // Parse de la réponse de succès
      const responseData = await resp.json();
      console.log('Réponse de succès:', responseData);

      // Succès: mise à jour de l'état de l'app et navigation
      dispatch({ type: 'SUBMIT_QUOTE', payload: quoteRequest });
      
      // Si le devis couvre tout le panier (pas de selectedProduct unique), vider le panier après 2s
      if (!state.selectedProduct) {
        setTimeout(() => {
          dispatch({ type: 'EXPLICIT_CLEAR_CART' });
        }, 2000);
      }
      
      // Fermer la modal immédiatement
      dispatch({ type: 'CLOSE_QUOTE_MODAL' });
      
      // Naviguer vers la page de succès
      navigate('/quote-success');
      
    } catch (err: any) {
      console.error('Échec de l\'envoi du devis:', err);
      
      let errorMessage = 'Une erreur est survenue lors de l\'envoi de votre demande.';
      
      if (err.name === 'TypeError' && err.message.includes('fetch')) {
        errorMessage = 'Erreur de connexion. Vérifiez votre connexion internet.';
      } else if (err.message) {
        errorMessage = err.message;
      }
      
      setError(errorMessage);
    } finally {
      setIsSubmitting(false);
    }
  };

  const totalPrice = products.reduce((sum: number, item: any) => sum + item.totalPrice, 0);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg max-w-2xl w-full max-h-[90vh] overflow-auto quote-modal-content">
        <div className="p-6">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-bold text-gray-800">Demander un devis</h2>
            <button
              onClick={() => { 
                setShowTemplate(false); 
                setError(null);
                dispatch({ type: 'CLOSE_QUOTE_MODAL' }); 
              }}
              className="text-gray-400 hover:text-gray-600 transition-colors"
              disabled={isSubmitting}
            >
              <X className="w-6 h-6" />
            </button>
          </div>

          {error && (
            <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg flex items-start space-x-3">
              <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div className="text-red-700">
                <p className="font-medium">Erreur</p>
                <p className="text-sm">{error}</p>
              </div>
            </div>
          )}
          
          {showTemplate ? (
            <div className="bg-gradient-to-br from-green-50 to-blue-50 p-6 rounded-lg shadow-lg border border-green-200">
              {/* Contenu du template de succès - identique au code original */}
              <div className="flex items-center mb-4">
                <div className="w-12 h-12 bg-green-500 rounded-full flex items-center justify-center mr-4">
                  <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-xl font-semibold text-green-800">✅ Demande envoyée avec succès!</h3>
                  <p className="text-sm text-green-600">Email professionnel envoyé à <span className="font-medium">marwenyoussef2017@gmail.com</span></p>
                </div>
              </div>

              {/* Carte de résumé */}
              <div className="bg-white p-5 rounded-lg shadow-sm border border-gray-200 mb-4">
                <h4 className="font-semibold text-gray-800 mb-3 flex items-center">
                  <svg className="w-5 h-5 mr-2 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Récapitulatif de votre demande
                </h4>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                  <div className="space-y-2">
                    <div><span className="text-gray-600">Nom:</span> <span className="font-medium">{formData.name}</span></div>
                    <div><span className="text-gray-600">Email:</span> <a href={`mailto:${formData.email}`} className="text-blue-600 hover:underline font-medium">{formData.email}</a></div>
                  </div>
                  <div className="space-y-2">
                    <div><span className="text-gray-600">Téléphone:</span> <span className="font-medium">{formData.phone}</span></div>
                    {formData.company && <div><span className="text-gray-600">Société:</span> <span className="font-medium">{formData.company}</span></div>}
                  </div>
                </div>

                <div className="border-t pt-4">
                  <h5 className="font-medium text-gray-800 mb-2">Produits sélectionnés:</h5>
                  <div className="space-y-2">
                    {products.map((item: any, idx: number) => (
                      <div key={idx} className="flex justify-between items-center bg-gray-50 p-2 rounded">
                        <span className="text-gray-700">{item.product.name}</span>
                        <span className="font-semibold text-blue-600">{item.totalPrice.toLocaleString()} TND</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 pt-2 border-t border-gray-200">
                    <div className="flex justify-between items-center">
                      <span className="text-lg font-semibold text-gray-800">Total estimé:</span>
                      <span className="text-xl font-bold text-blue-600">{totalPrice.toLocaleString()} TND</span>
                    </div>
                  </div>
                </div>

                {formData.message && (
                  <div className="mt-4 pt-4 border-t border-gray-200">
                    <h5 className="font-medium text-gray-800 mb-2">Votre message:</h5>
                    <div className="bg-gray-50 p-3 rounded text-gray-700 italic">
                      "{formData.message}"
                    </div>
                  </div>
                )}
              </div>

              {/* Prochaines étapes */}
              <div className="bg-blue-50 p-4 rounded-lg border border-blue-200">
                <h4 className="font-semibold text-blue-800 mb-2 flex items-center">
                  <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Prochaines étapes
                </h4>
                <ul className="text-sm text-blue-700 space-y-1">
                  <li>• Votre demande a été transmise à notre équipe commerciale</li>
                  <li>• Un expert vous contactera dans les <strong>24 heures</strong></li>
                  <li>• Vous recevrez un devis personnalisé avec les meilleures conditions</li>
                  <li>• Possibilité de négociation selon vos besoins spécifiques</li>
                </ul>
              </div>

              {/* Message de rechargement automatique */}
              <div className="mt-4 text-center">
                <p className="text-sm text-gray-600 mb-3">
                  ⏱️ La page se rechargera automatiquement dans 3 secondes...
                </p>
                <button
                  onClick={() => {
                    setShowTemplate(false);
                    dispatch({ type: 'TOGGLE_QUOTE_MODAL', payload: null });
                    window.location.reload();
                  }}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-6 py-2 rounded-lg transition-colors font-medium"
                >
                  Fermer maintenant
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              {/* Résumé des produits */}
              <div className="mb-6 bg-gray-50 p-4 rounded-lg">
                <h3 className="font-semibold mb-3">Produits concernés:</h3>
                <div className="space-y-2">
                  {products.map((item: any, index: number) => (
                    <div key={index} className="flex justify-between items-center text-sm">
                      <span>{item.product.name}</span>
                      <span className="font-medium">{item.totalPrice.toLocaleString()} TND</span>
                    </div>
                  ))}
                </div>
                <div className="border-t border-gray-300 mt-3 pt-3">
                  <div className="flex justify-between items-center font-semibold">
                    <span>Total estimé:</span>
                    <span className="text-blue-600">{totalPrice.toLocaleString()} TND</span>
                  </div>
                </div>
              </div>
              
              {/* Formulaire de contact */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Nom et prénom *
                  </label>
                  <input
                    type="text"
                    required
                    value={formData.name}
                    onChange={(e) => setFormData((prev: typeof formData) => ({ ...prev, name: e.target.value }))}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    disabled={isSubmitting}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Email *
                  </label>
                  <input
                    type="email"
                    required
                    value={formData.email}
                    onChange={(e) => setFormData((prev: typeof formData) => ({ ...prev, email: e.target.value }))}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    disabled={isSubmitting}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Téléphone *
                  </label>
                  <input
                    type="tel"
                    required
                    value={formData.phone}
                    onChange={(e) => setFormData((prev: typeof formData) => ({ ...prev, phone: e.target.value }))}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    disabled={isSubmitting}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Société
                  </label>
                  <input
                    type="text"
                    value={formData.company}
                    onChange={(e) => setFormData((prev: typeof formData) => ({ ...prev, company: e.target.value }))}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                    disabled={isSubmitting}
                  />
                </div>
              </div>
              
              <div className="mb-6">
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Message (optionnel)
                </label>
                <textarea
                  rows={4}
                  value={formData.message}
                  onChange={(e) => setFormData((prev: typeof formData) => ({ ...prev, message: e.target.value }))}
                  placeholder="Précisez vos besoins, quantités souhaitées, délais, ou toute autre information utile..."
                  className="w-full border border-gray-300 rounded-md px-3 py-2 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  disabled={isSubmitting}
                />
              </div>
              
              <div className="bg-blue-50 p-4 rounded-lg mb-6">
                <p className="text-sm text-blue-800">
                  <strong>Note:</strong> Nos experts vous contacteront dans les 24h avec un devis personnalisé incluant les prix, disponibilités et conditions de livraison.
                </p>
              </div>
              
              <button
                type="submit"
                disabled={isSubmitting}
                className={`w-full py-3 px-6 rounded-md transition-colors flex items-center justify-center space-x-2 ${
                  isSubmitting 
                    ? 'bg-gray-400 cursor-not-allowed' 
                    : 'bg-blue-600 hover:bg-blue-700'
                } text-white`}
              >
                {isSubmitting ? (
                  <>
                    <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white"></div>
                    <span>Envoi en cours...</span>
                  </>
                ) : (
                  <>
                    <Send className="w-5 h-5" />
                    <span>Envoyer la demande</span>
                  </>
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
